//! Master secret, address derivation and Photo Key.
//!
//! Mirrors the official wallet exactly:
//! - address derivation: noid_node/src/wallet/keystore.rs (MasterSecret)
//! - Photo Key + key fingerprint: noid_gui/src/secret.rs
//!
//! Tests check results against the official node and GUI (v2.0.4 vectors; unchanged in v2.1.0).

use std::collections::HashSet;
use std::path::Path;

use noid_core::{Block128, TowerField};
use noid_poseidon2b::native::compression::Poseidon2bSponge;
use noid_poseidon2b::primitives::{derive_address as derive_address_from_spend, Address, SpendSecret};
use rand::RngCore;
use zeroize::{Zeroize, Zeroizing};

use crate::Error;

pub const SECRET_LEN: usize = 32;
const IMAGE_SECRET_CONTEXT: &str = "ParanO(1)d master secret from canonical image pixels v1";
const KEY_ID_CONTEXT: &str = "ParanO(1)d master secret fingerprint v1";
/// Domain separation for gift card secrets (NOID mobile wallet only).
const GIFT_SECRET_CONTEXT: &str = "NOID mobile wallet 2026-10 gift card secret v1";
const MAX_SECRET_PHOTO_BYTES: u64 = 256 << 20;
const MIN_SECRET_PHOTO_DIMENSION: u32 = 32;
const MIN_SECRET_PHOTO_DISTINCT_PIXELS: usize = 64;
/// Same ceiling the official wallet enforces for derived addresses.
pub const MAX_WALLET_ADDRESSES: u32 = 100_000;

/// The 256-bit master secret. Zeroized on drop; never formatted.
#[derive(zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct MasterSecret([u8; SECRET_LEN]);

impl MasterSecret {
    pub fn generate() -> Self {
        let mut bytes = [0u8; SECRET_LEN];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let secret = MasterSecret(bytes);
        bytes.zeroize();
        secret
    }

    /// Parse the 64-character hex form used by the official wallet's
    /// Import / Export screens.
    pub fn from_hex(hex_str: &str) -> Result<Self, Error> {
        let trimmed = hex_str.trim();
        if trimmed.len() != SECRET_LEN * 2 {
            return Err(Error::msg("The master secret must be 64 hexadecimal characters."));
        }
        let mut bytes = Zeroizing::new([0u8; SECRET_LEN]);
        hex::decode_to_slice(trimmed, &mut *bytes)
            .map_err(|_| Error::msg("The master secret contains characters that are not hexadecimal."))?;
        if bytes.iter().all(|b| *b == 0) {
            return Err(Error::msg("The master secret cannot be all zeros."));
        }
        Ok(MasterSecret(*bytes))
    }

    pub fn to_hex(&self) -> Zeroizing<String> {
        Zeroizing::new(hex::encode(self.0))
    }

    /// `spend_secret_n = Poseidon2b(master_secret, n, "noid-deri")`
    /// Copied from noid_node/src/wallet/keystore.rs.
    pub fn derive_spend_secret(&self, index: u32) -> SpendSecret {
        let mut sponge = Poseidon2bSponge::with_iv([Block128::ZERO; 2]);
        let mut master_fields = Zeroizing::new([
            Block128::from(u128::from_le_bytes(self.0[..16].try_into().unwrap())),
            Block128::from(u128::from_le_bytes(self.0[16..].try_into().unwrap())),
        ]);
        sponge.absorb(master_fields[0]);
        sponge.absorb(master_fields[1]);
        master_fields.zeroize();
        sponge.absorb(Block128::from(index as u128));
        sponge.absorb(Block128::from(0x6E6F69642D64657269_u128)); // "noid-deri"
        let mut digest = sponge.finalize();
        let secret = SpendSecret::from_bytes(digest);
        digest.zeroize();
        secret
    }

    pub fn derive_address(&self, index: u32) -> Address {
        derive_address_from_spend(&self.derive_spend_secret(index))
    }

    /// Secret of gift card number `index`, derived one-way from this wallet's
    /// master secret. Gift secrets are handed to recipients inside links, so
    /// they must reveal nothing about the master; BLAKE3 key derivation is
    /// one-way. Being derived (not random) means a restored wallet can find
    /// and take back its unclaimed gifts.
    pub fn derive_gift_secret(&self, index: u32) -> MasterSecret {
        let mut hasher = blake3::Hasher::new_derive_key(GIFT_SECRET_CONTEXT);
        hasher.update(&self.0);
        hasher.update(&index.to_le_bytes());
        let mut out = *hasher.finalize().as_bytes();
        // The hasher's state holds the master secret's bytes: wipe it too.
        hasher.zeroize();
        let secret = MasterSecret(out);
        out.zeroize();
        secret
    }

    /// Short fingerprint shown by the official wallet (e.g. `ab12·cd34·ef56·7890`)
    /// so a user can confirm they restored the same wallet.
    pub fn key_id(&self) -> String {
        let mut hasher = blake3::Hasher::new_derive_key(KEY_ID_CONTEXT);
        hasher.update(&self.0);
        let digest = hasher.finalize();
        hasher.zeroize();
        let encoded = hex::encode(&digest.as_bytes()[..8]);
        format!("{}·{}·{}·{}", &encoded[..4], &encoded[4..8], &encoded[8..12], &encoded[12..])
    }
}

pub struct PhotoKey {
    pub secret: MasterSecret,
    pub width: u32,
    pub height: u32,
}

/// Derive a master secret from a photo's decoded pixels (official Photo Key v1).
/// The photo is decoded here with the same Rust decoder as the desktop wallet;
/// using Android's decoder could change pixels and therefore the wallet.
pub fn photo_key_from_path(path: &Path) -> Result<PhotoKey, Error> {
    let meta = std::fs::metadata(path).map_err(|e| Error::msg(format!("Could not read the photo: {e}")))?;
    if !meta.is_file() {
        return Err(Error::msg("The selected photo is not a file."));
    }
    let size = meta.len();
    if size == 0 {
        return Err(Error::msg("The selected photo is empty."));
    }
    if size > MAX_SECRET_PHOTO_BYTES {
        return Err(Error::msg("The selected photo is larger than 256 MiB."));
    }
    let reader = image::ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| Error::msg(format!("Could not open the photo: {e}")))?;
    let format = reader.format();
    if format == Some(image::ImageFormat::Tiff) {
        refuse_jpeg_in_tiff(path)?;
    }
    let decoded = reader.decode().map_err(|e| {
        Error::msg(format!(
            "Unsupported or unsafe photo. Use a private JPEG, PNG, WebP, GIF, BMP, or TIFF: {e}"
        ))
    })?;
    if format == Some(image::ImageFormat::Jpeg) {
        check_jpeg_decode_is_portable(path, &decoded)?;
    }
    let width = decoded.width();
    let height = decoded.height();
    let mut rgba = decoded.to_rgba8();
    let result = validate_photo(width, height, rgba.as_raw())
        .map(|()| derive_image_secret(width, height, rgba.as_raw()));
    use std::ops::DerefMut;
    rgba.deref_mut().zeroize();
    let mut bytes = result?;
    let secret = MasterSecret(bytes);
    bytes.zeroize();
    Ok(PhotoKey { secret, width, height })
}

/// A TIFF can hold JPEG-compressed pixels, which its decoder reads with the
/// fast CPU-specific JPEG path and no portability check. Refuse those, so a
/// Photo Key never depends on which device made it.
fn refuse_jpeg_in_tiff(path: &Path) -> Result<(), Error> {
    let file = std::fs::File::open(path).map_err(|e| Error::msg(format!("Could not read the photo: {e}")))?;
    let Ok(mut decoder) = tiff::decoder::Decoder::new(std::io::BufReader::new(file)) else {
        // Not readable as TIFF: the image decoder reports it.
        return Ok(());
    };
    // Compression 6 (old-style JPEG) and 7 (JPEG).
    match decoder.find_tag_unsigned::<u16>(tiff::tags::Tag::Compression) {
        Ok(Some(6 | 7)) => Err(Error::msg(
            "This TIFF photo stores its picture as JPEG inside, which different devices can decode differently. \
             Use the original JPEG, or a PNG.",
        )),
        _ => Ok(()),
    }
}

/// The JPEG decoder uses CPU-specific fast paths (AVX2 on PCs, NEON on phones).
/// The wallet must not depend on which one ran, so decode again on the plain
/// scalar path and refuse the photo if a single pixel differs.
fn check_jpeg_decode_is_portable(path: &Path, decoded: &image::DynamicImage) -> Result<(), Error> {
    use zune_core::bytestream::ZCursor;
    use zune_core::colorspace::ColorSpace;
    use zune_core::options::DecoderOptions;

    let (space, fast): (ColorSpace, &[u8]) = match decoded {
        image::DynamicImage::ImageRgb8(img) => (ColorSpace::RGB, img.as_raw()),
        image::DynamicImage::ImageLuma8(img) => (ColorSpace::Luma, img.as_raw()),
        // Other JPEG layouts (e.g. CMYK) are rare; the per-device self-test still guards them.
        _ => return Ok(()),
    };
    let bytes = Zeroizing::new(std::fs::read(path).map_err(|e| Error::msg(format!("Could not read the photo: {e}")))?);
    let options = DecoderOptions::default().set_use_unsafe(false).jpeg_set_out_colorspace(space);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(&bytes[..]), options);
    let mut scalar = decoder
        .decode()
        .map_err(|e| Error::msg(format!("Could not decode the photo: {e:?}")))?;
    let same = scalar.as_slice() == fast;
    scalar.zeroize();
    if same {
        Ok(())
    } else {
        Err(Error::coded(
            "photo_not_portable",
            "This phone decodes the photo slightly differently from the desktop wallet, so it would not give the same wallet everywhere. Use a PNG copy of the photo, or a hex secret.",
        ))
    }
}

/// Recreate the official GUI's golden JPEG on this device and check that it
/// yields the published key. Run before offering Photo Key on a new phone.
pub fn photo_key_self_test() -> Result<bool, Error> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, ImageEncoder};
    let dir = std::env::temp_dir().join(format!("noid-selftest-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| Error::msg(e.to_string()))?;
    let path = dir.join("golden.jpg");
    let pixels = (0..32 * 32)
        .flat_map(|index| {
            let x = (index % 32) as u8;
            let y = (index / 32) as u8;
            [x * 7, y * 5, x.wrapping_mul(y).wrapping_mul(3)]
        })
        .collect::<Vec<_>>();
    let file = std::fs::File::create(&path).map_err(|e| Error::msg(e.to_string()))?;
    JpegEncoder::new_with_quality(file, 83)
        .write_image(&pixels, 32, 32, ExtendedColorType::Rgb8)
        .map_err(|e| Error::msg(e.to_string()))?;
    let result = photo_key_from_path(&path).map(|k| {
        k.secret.to_hex().as_str() == "15e9b1e6005a3b5670784debbf5abd3e375f5be603f286fa3221a87bf982ac64"
    });
    std::fs::remove_dir_all(&dir).ok();
    result
}

fn validate_photo(width: u32, height: u32, rgba: &[u8]) -> Result<(), Error> {
    if width < MIN_SECRET_PHOTO_DIMENSION || height < MIN_SECRET_PHOTO_DIMENSION {
        return Err(Error::msg(format!(
            "The photo must be at least {MIN_SECRET_PHOTO_DIMENSION} × {MIN_SECRET_PHOTO_DIMENSION} pixels."
        )));
    }
    let mut distinct = HashSet::with_capacity(MIN_SECRET_PHOTO_DISTINCT_PIXELS);
    for pixel in rgba.chunks_exact(4) {
        distinct.insert([pixel[0], pixel[1], pixel[2], pixel[3]]);
        if distinct.len() >= MIN_SECRET_PHOTO_DISTINCT_PIXELS {
            return Ok(());
        }
    }
    Err(Error::msg(format!(
        "The photo must contain at least {MIN_SECRET_PHOTO_DISTINCT_PIXELS} distinct pixel values. Pick a real photo, not a flat image."
    )))
}

pub(crate) fn derive_image_secret(width: u32, height: u32, rgba: &[u8]) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new_derive_key(IMAGE_SECRET_CONTEXT);
    hasher.update(b"RGBA8");
    hasher.update(&width.to_le_bytes());
    hasher.update(&height.to_le_bytes());
    hasher.update(&(rgba.len() as u64).to_le_bytes());
    hasher.update(rgba);
    let out = *hasher.finalize().as_bytes();
    hasher.zeroize();
    out
}

pub fn parse_address(address: &str) -> Result<Address, Error> {
    Address::parse(address.trim()).map_err(|e| Error::msg(format!("That is not a valid NOID address: {e}")))
}

#[cfg(test)]
mod tests {

    #[test]
    fn gift_secrets_are_stable_distinct_and_one_way() {
        let master = MasterSecret::from_hex(&"01".repeat(32)).unwrap();
        let g0 = master.derive_gift_secret(0);
        let g0b = master.derive_gift_secret(0);
        let g1 = master.derive_gift_secret(1);
        assert_eq!(*g0.to_hex(), *g0b.to_hex());
        assert_ne!(*g0.to_hex(), *g1.to_hex());
        assert_ne!(*g0.to_hex(), *master.to_hex());
        assert_ne!(g0.derive_address(0), master.derive_address(0));
        // Gift secrets are valid wallet secrets in their own right.
        assert!(MasterSecret::from_hex(&g0.to_hex()).is_ok());
    }
    use super::*;

    /// Golden vectors taken from the official parano1d v2.0.4 release binary
    /// (walletListAddresses) for master secret 0x01..0x20.
    #[test]
    fn addresses_match_official_node() {
        let secret =
            MasterSecret::from_hex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20").unwrap();
        let expected = [
            "o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk",
            "o1e7mkgm5cm9ngrexup6wpgkzzy9qzp25fwl223epu2llkpa7ftz9sx0fcsx",
            "o1lfmqghyp8m3qzju29v8eup95t7h5hleejnvtzcdjudnkc86x2grqx0jfmp",
            "o1smjr25tk2j43xn0ne7nfgse8p882ly4fjvk7jaredxm0wyu55haq0wthx0",
        ];
        for (index, want) in expected.iter().enumerate() {
            assert_eq!(secret.derive_address(index as u32).to_bech32(), *want, "index {index}");
        }
    }

    /// Golden vector from noid_gui/src/secret.rs tests.
    #[test]
    fn image_secret_matches_official_vector() {
        let pixels = [
            0x10, 0x20, 0x30, 0xff, 0x40, 0x50, 0x60, 0xff, 0x70, 0x80, 0x90, 0xff, 0xa0, 0xb0, 0xc0, 0xff,
        ];
        assert_eq!(
            hex::encode(derive_image_secret(2, 2, &pixels)),
            "8d96ff98f464d528b9a1dd123059276dd34bf9735a5c99e2dba17273a5f8286c"
        );
    }

    /// Same JPEG the official GUI test encodes; its decoded pixels must give
    /// the same master secret on every platform.
    #[test]
    fn jpeg_photo_matches_official_golden_key() {
        use image::codecs::jpeg::JpegEncoder;
        use image::{ExtendedColorType, ImageEncoder};
        let dir = std::env::temp_dir().join(format!("noid-photo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("photo.jpg");
        let pixels = (0..32 * 32)
            .flat_map(|index| {
                let x = (index % 32) as u8;
                let y = (index / 32) as u8;
                [x * 7, y * 5, x.wrapping_mul(y).wrapping_mul(3)]
            })
            .collect::<Vec<_>>();
        JpegEncoder::new_with_quality(std::fs::File::create(&path).unwrap(), 83)
            .write_image(&pixels, 32, 32, ExtendedColorType::Rgb8)
            .unwrap();
        let key = photo_key_from_path(&path).unwrap();
        assert_eq!(
            key.secret.to_hex().as_str(),
            "15e9b1e6005a3b5670784debbf5abd3e375f5be603f286fa3221a87bf982ac64"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn self_test_passes_on_this_cpu() {
        assert!(photo_key_self_test().unwrap());
    }

    #[test]
    fn rejects_bad_secrets() {
        assert!(MasterSecret::from_hex("abc").is_err());
        assert!(MasterSecret::from_hex(&"z".repeat(64)).is_err());
        assert!(MasterSecret::from_hex(&"0".repeat(64)).is_err());
        let generated = MasterSecret::generate();
        let round = MasterSecret::from_hex(&generated.to_hex()).unwrap();
        assert_eq!(generated.key_id(), round.key_id());
    }
}
