//! Parano1d v2.1 tokens and NFTs: checks on what the wallet server reports.
//!
//! The server passes on the node's raw State records ("openings"). Each one is
//! decoded here with the official crate and checked the same way the official
//! desktop wallet checks them (noid_gui/src/assets/live.rs and catalog.rs):
//! the record's root, kind and timelock match its opening, the opening is owned
//! by this wallet's address, and it is bound to its State slot. Names, tickers
//! and images are public metadata whose hashes are committed in State; they are
//! checked against those hashes (noid_gui/src/assets/media.rs).
//!
//! Like the NOID balance, these records come from the wallet server, and this
//! does not yet prove they are in the chain's State. The checks catch garbled,
//! foreign or mismatched records and media files that differ from the hash in
//! the record, but a deliberately dishonest server could still make up records.
//! The screens that use them only display; nothing is signed from them.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;

use noid_tx::native_assets::{
    launch::LaunchOpening,
    market::{MarketOpening, PoolPhase},
    native_sequence,
    nft_market::{ListingState, NftMarketOpening},
    NativeOpening, MAX_NATIVE_OPENING_BYTES, TOKEN_DECIMALS,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::keys::parse_address;
use crate::Error;

/// More records than any phone wallet should need to show; bounds the work.
pub const MAX_HOLDINGS: usize = 4096;
const MAX_MANIFEST_BYTES: usize = 8192;
pub const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
const METADATA_DOMAIN: &[u8] = b"Parano1d/native-metadata/v1\0";
const IMAGE_DOMAIN: &[u8] = b"Parano1d/native-image/v1\0";

fn bad(message: &str) -> Error {
    Error::coded("bad_assets", message)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub root: String,
    pub kind: u16,
    pub opening_hex: String,
    pub dependency_hex: Option<String>,
    pub slot_index: u32,
    pub creation_id: String,
    pub amount_micronoid: String,
    pub unlock_height: u64,
    #[serde(default)]
    pub reserved: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsPage {
    pub owner: String,
    pub height: u64,
    pub block_hash: String,
    pub state_root: String,
    pub holdings: Vec<Holding>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogItem {
    pub key: String,
    pub primary: Holding,
    pub related: Vec<Holding>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDetails {
    pub height: u64,
    pub block_hash: String,
    pub state_root: String,
    pub item: Option<CatalogItem>,
}

/// Exact decimal integer, as the node writes it (no sign, no leading zeros).
fn integer(value: &str) -> Result<u64, Error> {
    let parsed: u64 = value.parse().map_err(|_| bad("A token record has an invalid number."))?;
    if parsed.to_string() != value {
        return Err(bad("A token record has an invalid number."));
    }
    Ok(parsed)
}

fn digest_hex(value: &str) -> Result<[u8; 32], Error> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(bad("A token record has an invalid identity."));
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(value, &mut out).map_err(|_| bad("A token record has an invalid identity."))?;
    Ok(out)
}

fn decode_opening(encoded: &str) -> Result<NativeOpening, Error> {
    if encoded.len() > 2 * MAX_NATIVE_OPENING_BYTES {
        return Err(bad("A token record is too large."));
    }
    let bytes = hex::decode(encoded).map_err(|_| bad("A token record has an invalid encoding."))?;
    NativeOpening::from_bytes(&bytes).map_err(|_| bad("A token record could not be read."))
}

/// Decode one record and check it against its State slot (official checks).
fn opening_of(item: &Holding) -> Result<(NativeOpening, Option<NativeOpening>, u64), Error> {
    let opening = decode_opening(&item.opening_hex)?;
    let dependency = item.dependency_hex.as_deref().map(decode_opening).transpose()?;
    let creation_id = integer(&item.creation_id)?;
    let amount = integer(&item.amount_micronoid)?;
    native_sequence(creation_id).map_err(|_| bad("A token record has an invalid origin."))?;
    if item.root != hex::encode(opening.root().0)
        || item.kind != opening.kind() as u16
        || item.unlock_height != opening.unlock_height()
    {
        return Err(bad("A token record differs from its State entry."));
    }
    opening.check_dependency(dependency).map_err(|_| bad("A token record has different terms."))?;
    opening
        .check_input_binding(&noid_tx::TxInput { slot_index: item.slot_index, amount, creation_id }, opening.root())
        .map_err(|_| bad("A token record differs from its State entry."))?;
    Ok((opening, dependency, creation_id))
}

#[derive(Default)]
struct TokenSum {
    units: u128,
    locked: u128,
    reserved: u128,
    outputs: usize,
    issued_here: bool,
}

/// Tokens and NFTs owned by `owner`, from the server's holdings records.
pub fn check_holdings(owner: &str, page: &HoldingsPage) -> Result<Value, Error> {
    let owner = parse_address(owner)?.to_bech32();
    if page.owner != owner {
        return Err(bad("The server sent tokens for a different address."));
    }
    digest_hex(&page.block_hash)?;
    digest_hex(&page.state_root)?;
    if page.holdings.len() > MAX_HOLDINGS {
        return Err(bad("The server sent too many token records."));
    }
    let mut slots = BTreeSet::new();
    let mut tokens: BTreeMap<[u8; 32], TokenSum> = BTreeMap::new();
    let mut nfts: BTreeMap<([u8; 32], u64), Value> = BTreeMap::new();
    let mut collections = 0usize;
    let mut other = 0usize;
    for item in &page.holdings {
        if !slots.insert(item.slot_index) {
            return Err(bad("The server sent the same token record twice."));
        }
        let (opening, dependency, _) = opening_of(item)?;
        let owners = opening.owners_with_dependency(dependency).map_err(|_| bad("A token record has different terms."))?;
        if !owners.iter().any(|o| o.to_bech32() == owner) {
            return Err(bad("The server sent a token record that belongs to another address."));
        }
        match &opening {
            NativeOpening::TokenBalance(balance) => {
                let sum = tokens.entry(balance.asset.0).or_default();
                let units = u128::from(balance.units);
                sum.units += units;
                // Same rule as the official wallet: spendable from the next block on.
                if balance.unlock_height > page.height.saturating_add(1) {
                    sum.locked += units;
                } else if item.reserved {
                    sum.reserved += units;
                }
                sum.outputs += 1;
            }
            NativeOpening::FungibleDefinition(definition) => {
                tokens.entry(definition.asset.0).or_default().issued_here = true;
            }
            NativeOpening::NftItem(nft) => {
                let id = (nft.collection.0, nft.serial);
                let value = json!({
                    "collection": hex::encode(nft.collection.0),
                    "serial": nft.serial.to_string(),
                    "metadata": hex::encode(nft.metadata),
                    "unlockHeight": nft.unlock_height,
                    "locked": nft.unlock_height > page.height.saturating_add(1),
                    "listing": Value::Null,
                    "reserved": item.reserved,
                });
                if nfts.insert(id, value).is_some() {
                    return Err(bad("The server sent the same NFT twice."));
                }
            }
            NativeOpening::NftMarket(NftMarketOpening::Listing(state)) => {
                let Some(NativeOpening::NftMarket(NftMarketOpening::Definition(def))) = dependency else {
                    return Err(bad("An NFT listing is missing its terms."));
                };
                let id = (def.collection.0, def.serial);
                let value = json!({
                    "collection": hex::encode(def.collection.0),
                    "serial": def.serial.to_string(),
                    "metadata": hex::encode(def.metadata),
                    "unlockHeight": 0,
                    "locked": false,
                    "listing": { "askMicronoid": def.ask, "expiryHeight": def.expiry_height, "ready": listing_is_fresh(*state, def) },
                    "reserved": item.reserved,
                });
                if nfts.insert(id, value).is_some() {
                    return Err(bad("The server sent the same NFT twice."));
                }
            }
            NativeOpening::NftCollection(_) => collections += 1,
            // Trade requests, pool positions and other records: not shown yet.
            _ => other += 1,
        }
    }
    let tokens: Vec<Value> = tokens
        .into_iter()
        .map(|(id, s)| {
            json!({
                "assetId": hex::encode(id),
                "units": s.units.to_string(),
                "lockedUnits": s.locked.to_string(),
                "reservedUnits": s.reserved.to_string(),
                "outputs": s.outputs,
                "issuedHere": s.issued_here,
            })
        })
        .collect();
    Ok(json!({
        "owner": owner,
        "height": page.height,
        "blockHash": page.block_hash,
        "stateRoot": page.state_root,
        "decimals": TOKEN_DECIMALS,
        "tokens": tokens,
        "nfts": nfts.into_values().collect::<Vec<_>>(),
        "collections": collections,
        "other": other,
    }))
}

/// A token's public definition and market, from the node's market record.
pub fn check_token(asset_id: &str, details: &MarketDetails) -> Result<Value, Error> {
    let asset = digest_hex(asset_id)?;
    digest_hex(&details.block_hash)?;
    digest_hex(&details.state_root)?;
    let Some(item) = &details.item else {
        return Ok(json!({ "assetId": asset_id, "known": false }));
    };
    if item.related.len() != 2 {
        return Err(bad("The token's terms are incomplete."));
    }
    let mut slots = BTreeSet::new();
    for record in std::iter::once(&item.primary).chain(&item.related) {
        if !slots.insert(record.slot_index) {
            return Err(bad("The token's terms repeat a State entry."));
        }
    }
    let (opening, dependency, _) = opening_of(&item.primary)?;
    let (token, _, _) = opening_of(&item.related[0])?;
    let (reserve, _, _) = opening_of(&item.related[1])?;
    let NativeOpening::FungibleDefinition(token) = token else {
        return Err(bad("The server sent an invalid token definition."));
    };
    let NativeOpening::TokenReserve(reserve) = reserve else {
        return Err(bad("The server sent invalid token backing."));
    };
    if token.asset.0 != asset {
        return Err(bad("The server sent a different token."));
    }
    reserve.check_definition(&token).map_err(|_| bad("The token's backing has different terms."))?;
    let mut expected_key = 0x8000u16.to_be_bytes().to_vec();
    expected_key.extend_from_slice(&asset);
    if item.key != hex::encode(expected_key) {
        return Err(bad("The server sent a different token."));
    }
    // Price: NOID base units per token base unit = numerator / denominator.
    let (phase, numerator, denominator, ready) = match (opening, dependency) {
        (
            NativeOpening::Launch(LaunchOpening::State(state)),
            Some(NativeOpening::Launch(LaunchOpening::Definition(def))),
        ) => {
            if def.asset != token.asset
                || def.definition_root != NativeOpening::FungibleDefinition(token).root()
                || def.initial_supply != token.initial_supply
            {
                return Err(bad("The token's launch differs from the token."));
            }
            let sold = def
                .initial_supply
                .checked_sub(state.inventory_units)
                .ok_or_else(|| bad("The token's launch has invalid numbers."))?;
            let price = def.marginal_price(sold).map_err(|_| bad("The token's launch has invalid numbers."))?;
            ("curve", price.numerator, price.denominator, state.phase == PoolPhase::Idle)
        }
        (
            NativeOpening::Market(MarketOpening::Pool(state)),
            Some(NativeOpening::Market(MarketOpening::Definition(def))),
        ) if def.base_is_noid() && def.quote == token.asset => {
            ("dex", state.base_reserve, state.quote_reserve, state.phase == PoolPhase::Idle)
        }
        _ => return Err(bad("The server sent an unsupported token market.")),
    };
    Ok(json!({
        "assetId": asset_id,
        "known": true,
        "metadata": hex::encode(token.metadata),
        "issuer": token.issuer.to_bech32(),
        "initialSupply": token.initial_supply.to_string(),
        "outstanding": reserve.outstanding_units.to_string(),
        "backingMicronoid": reserve.reserve_micronoid.to_string(),
        "phase": phase,
        "priceNumerator": numerator.to_string(),
        "priceDenominator": denominator.to_string(),
        "ready": ready,
        "height": details.height,
    }))
}

/// True when an NFT listing record is still in its first state (nothing pending).
pub fn listing_is_fresh(state: ListingState, def: noid_tx::native_assets::nft_market::ListingDefinition) -> bool {
    ListingState::initial(def).ok() == Some(state)
}

// ---------- Public metadata (names, tickers, pictures) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Token,
    Collection,
    Nft,
}

impl MediaKind {
    fn dimension(self) -> u32 {
        if self == Self::Nft {
            2048
        } else {
            512
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaImage {
    pub hash: String,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u32,
}

/// Field order and skip rules match the official wallet exactly: the hash is
/// taken over this canonical JSON form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: u8,
    pub kind: MediaKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub website: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub image: Option<MediaImage>,
}

/// No control characters and no invisible or direction-changing characters
/// (they can make one name look like another).
fn safe_text(value: &str, bytes: usize, characters: usize, multiline: bool) -> bool {
    value.len() <= bytes
        && value.chars().count() <= characters
        && value.trim() == value
        && !value.chars().any(|c| {
            (c.is_control() && !(multiline && c == '\n'))
                || matches!(c, '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
        })
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// https only, a host, and no user name or password in the link.
pub fn valid_website(value: &str) -> bool {
    if !safe_text(value, 2048, 2048, false) || value.chars().any(char::is_whitespace) {
        return false;
    }
    let Some(rest) = value.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    !authority.is_empty()
        && !authority.contains('@')
        && authority.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'))
        && !authority.starts_with(':')
}

fn content_hash(domain: &[u8], bytes: &[u8]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(domain);
    hasher.update(bytes);
    hasher.finalize().to_hex().to_string()
}

impl Manifest {
    pub fn validate(&self) -> Result<(), Error> {
        if self.schema != 1 || self.name.is_empty() || !safe_text(&self.name, 256, 64, false) {
            return Err(bad("The token's name is not valid."));
        }
        if !safe_text(&self.description, 4096, 1000, true) {
            return Err(bad("The token's description is not valid."));
        }
        if self.website.as_deref().is_some_and(|url| !valid_website(url)) {
            return Err(bad("The token's website is not valid."));
        }
        if self.kind == MediaKind::Token {
            let symbol = self.symbol.as_deref().unwrap_or_default();
            if symbol.is_empty()
                || symbol.len() > 12
                || !symbol.as_bytes()[0].is_ascii_uppercase()
                || !symbol.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                || symbol == "NOID"
            {
                return Err(bad("The token's ticker is not valid."));
            }
        } else if self.symbol.is_some() {
            return Err(bad("Only tokens have a ticker."));
        }
        if let Some(image) = &self.image {
            if !is_digest(&image.hash)
                || image.media_type != "image/png"
                || image.width == 0
                || image.height == 0
                || image.width > self.kind.dimension()
                || image.height > self.kind.dimension()
                || image.bytes == 0
                || u64::from(image.bytes) > MAX_IMAGE_BYTES
            {
                return Err(bad("The token's picture has an unsupported format or size."));
            }
        } else if self.kind == MediaKind::Nft {
            return Err(bad("An NFT must have a picture."));
        }
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        let mut bytes = serde_json::to_vec(self).map_err(|_| bad("The token's details could not be read."))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(bad("The token's details are too long."));
        }
        Ok(bytes)
    }

    pub fn hash(&self) -> Result<String, Error> {
        Ok(content_hash(METADATA_DOMAIN, &self.canonical_bytes()?))
    }
}

/// Parse downloaded metadata and check it is the one State committed to.
pub fn check_metadata(expected_hash: &str, text: &str, kind: MediaKind) -> Result<Manifest, Error> {
    if !is_digest(expected_hash) {
        return Err(bad("Invalid metadata identity."));
    }
    if text.len() > MAX_MANIFEST_BYTES {
        return Err(bad("The token's details are too long."));
    }
    let manifest: Manifest = serde_json::from_str(text).map_err(|_| bad("The token's details could not be read."))?;
    if manifest.kind != kind {
        return Err(bad("The details are for a different kind of asset."));
    }
    // Same as the official wallet: the hash of the canonical form must match.
    if manifest.hash()? != expected_hash {
        return Err(bad("The token's details differ from what the token committed to."));
    }
    Ok(manifest)
}

/// Check a downloaded picture file against its metadata entry.
pub fn check_image_file(path: &Path, image: &MediaImage) -> Result<(), Error> {
    if !is_digest(&image.hash) || image.media_type != "image/png" {
        return Err(bad("Invalid picture identity."));
    }
    let file = std::fs::File::open(path).map_err(|_| bad("The picture could not be read."))?;
    let mut png = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut png)
        .map_err(|_| bad("The picture could not be read."))?;
    if png.len() as u64 != u64::from(image.bytes) || png.len() as u64 > MAX_IMAGE_BYTES {
        return Err(bad("The picture differs from what the token committed to."));
    }
    if content_hash(IMAGE_DOMAIN, &png) != image.hash {
        return Err(bad("The picture differs from what the token committed to."));
    }
    // PNG signature, then the IHDR chunk with width and height.
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if png.len() < 24 || png[..8] != SIGNATURE || &png[12..16] != b"IHDR" {
        return Err(bad("The picture is not a PNG image."));
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if width != image.width || height != image.height {
        return Err(bad("The picture differs from what the token committed to."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use noid_poseidon2b::primitives::Address;
    use noid_tx::native_assets::{
        nft_market::ListingDefinition, AssetId, CollectionId, FungibleDefinition, IssuanceRoute, NftItem, TokenBalance,
        NATIVE_CREATION_TAG,
    };

    fn owner() -> Address {
        parse_address("o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk").unwrap()
    }
    fn stranger() -> Address {
        parse_address("o1e7mkgm5cm9ngrexup6wpgkzzy9qzp25fwl223epu2llkpa7ftz9sx0fcsx").unwrap()
    }

    fn holding(opening: NativeOpening, dependency: Option<NativeOpening>, slot: u32, seq: u64) -> Holding {
        Holding {
            root: hex::encode(opening.root().0),
            kind: opening.kind() as u16,
            opening_hex: hex::encode(opening.to_bytes().unwrap()),
            dependency_hex: dependency.map(|d| hex::encode(d.to_bytes().unwrap())),
            slot_index: slot,
            creation_id: (NATIVE_CREATION_TAG | seq).to_string(),
            amount_micronoid: opening.amount_micronoid().to_string(),
            unlock_height: opening.unlock_height(),
            reserved: false,
        }
    }

    fn page(holdings: Vec<Holding>) -> HoldingsPage {
        HoldingsPage {
            owner: owner().to_bech32(),
            height: 300_000,
            block_hash: "11".repeat(32),
            state_root: "22".repeat(32),
            holdings,
        }
    }

    fn balance(asset: u8, units: u64, unlock: u64, to: Address) -> NativeOpening {
        NativeOpening::TokenBalance(TokenBalance { asset: AssetId([asset; 32]), owner: to, units, unlock_height: unlock })
    }

    #[test]
    fn sums_tokens_and_lists_nfts() {
        let nft = NativeOpening::NftItem(NftItem {
            collection: CollectionId([9; 32]),
            owner: owner(),
            metadata: [7; 32],
            serial: 4,
            unlock_height: 0,
        });
        let p = page(vec![
            holding(balance(1, 2_500_000, 0, owner()), None, 10, 1),
            holding(balance(1, 500_000, 400_000, owner()), None, 11, 2),
            holding(balance(2, 1, 0, owner()), None, 12, 3),
            holding(nft, None, 13, 4),
        ]);
        let out = check_holdings(&owner().to_bech32(), &p).unwrap();
        let tokens = out["tokens"].as_array().unwrap();
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0]["assetId"], "01".repeat(32));
        assert_eq!(tokens[0]["units"], "3000000");
        assert_eq!(tokens[0]["lockedUnits"], "500000");
        assert_eq!(tokens[0]["outputs"], 2);
        assert_eq!(out["nfts"][0]["serial"], "4");
        assert_eq!(out["nfts"][0]["metadata"], "07".repeat(32));
        assert_eq!(out["decimals"], 6);
    }

    #[test]
    fn rejects_records_that_are_not_ours_or_altered() {
        // Someone else's token.
        let p = page(vec![holding(balance(1, 5, 0, stranger()), None, 10, 1)]);
        assert!(check_holdings(&owner().to_bech32(), &p).is_err());

        // A server that inflates the amount in the record but not the opening.
        let mut h = holding(balance(1, 5, 0, owner()), None, 10, 1);
        h.root = "33".repeat(32);
        assert!(check_holdings(&owner().to_bech32(), &page(vec![h])).is_err());

        // A plain NOID coin's origin (not a native record).
        let mut h = holding(balance(1, 5, 0, owner()), None, 10, 1);
        h.creation_id = "77".into();
        assert!(check_holdings(&owner().to_bech32(), &page(vec![h])).is_err());

        // Same slot twice.
        let a = holding(balance(1, 5, 0, owner()), None, 10, 1);
        let b = holding(balance(2, 5, 0, owner()), None, 10, 2);
        assert!(check_holdings(&owner().to_bech32(), &page(vec![a, b])).is_err());

        // Records for a different address than the one asked about.
        let mut p = page(vec![]);
        p.owner = stranger().to_bech32();
        assert!(check_holdings(&owner().to_bech32(), &p).is_err());
    }

    #[test]
    fn listed_nft_is_still_shown_as_ours() {
        let item = NftItem { collection: CollectionId([9; 32]), owner: owner(), metadata: [7; 32], serial: 2, unlock_height: 0 };
        let def = ListingDefinition::from_item(item, NATIVE_CREATION_TAG | 5, 1_000_000, 300_100, 300_000).unwrap();
        let state = ListingState::initial(def).unwrap();
        assert!(listing_is_fresh(state, def));
        let listing = NativeOpening::NftMarket(NftMarketOpening::Listing(state));
        let definition = NativeOpening::NftMarket(NftMarketOpening::Definition(def));
        let p = page(vec![holding(listing, Some(definition), 20, 6)]);
        let out = check_holdings(&owner().to_bech32(), &p).unwrap();
        assert_eq!(out["nfts"][0]["listing"]["askMicronoid"], 1_000_000);
    }

    #[test]
    fn unknown_token_market_is_reported_as_unknown() {
        let d = MarketDetails { height: 1, block_hash: "11".repeat(32), state_root: "22".repeat(32), item: None };
        let out = check_token(&"01".repeat(32), &d).unwrap();
        assert_eq!(out["known"], false);
        assert!(check_token("nothex", &d).is_err());
    }

    #[test]
    fn token_market_must_match_the_asset() {
        // A definition record for another asset is refused.
        let def = NativeOpening::FungibleDefinition(FungibleDefinition {
            asset: AssetId([5; 32]),
            issuer: owner(),
            initial_supply: 100_000_000_000,
            route: IssuanceRoute::Launchpad,
            metadata: [3; 32],
        });
        let h = holding(def, None, 1, 1);
        let item = CatalogItem { key: format!("8000{}", "01".repeat(32)), primary: h.clone(), related: vec![h.clone(), h] };
        let d = MarketDetails { height: 1, block_hash: "11".repeat(32), state_root: "22".repeat(32), item: Some(item) };
        assert!(check_token(&"01".repeat(32), &d).is_err());
    }

    #[test]
    fn launchpad_token_reports_metadata_and_price() {
        use noid_tx::native_assets::launch::{LaunchDefinition, LaunchState};
        use noid_tx::native_assets::{GenesisAnchor, TokenReserve};
        let anchor = GenesisAnchor {
            chain: [4; 32],
            owner: owner(),
            input: noid_tx::TxInput { slot_index: 77, amount: 200_000_000, creation_id: 12 },
        };
        let supply = 100_000 * 1_000_000;
        let token = FungibleDefinition::from_genesis(&anchor, supply, IssuanceRoute::Launchpad, [3; 32]).unwrap();
        let launch = LaunchDefinition::from_genesis(&anchor, token).unwrap();
        let state = LaunchState::initial(launch).unwrap();
        let reserve = TokenReserve::from_definition(&token, 100_000_000).unwrap();
        let item = CatalogItem {
            key: format!("8000{}", hex::encode(token.asset.0)),
            primary: holding(
                NativeOpening::Launch(LaunchOpening::State(state)),
                Some(NativeOpening::Launch(LaunchOpening::Definition(launch))),
                1,
                1,
            ),
            related: vec![
                holding(NativeOpening::FungibleDefinition(token), None, 2, 2),
                holding(NativeOpening::TokenReserve(reserve), None, 3, 3),
            ],
        };
        let d = MarketDetails { height: 9, block_hash: "11".repeat(32), state_root: "22".repeat(32), item: Some(item) };
        let id = hex::encode(token.asset.0);
        let out = check_token(&id, &d).unwrap();
        assert_eq!(out["known"], true);
        assert_eq!(out["metadata"], "03".repeat(32));
        assert_eq!(out["phase"], "curve");
        assert_eq!(out["issuer"], owner().to_bech32());
        // The launch starts near 1/300 NOID per token.
        let n: f64 = out["priceNumerator"].as_str().unwrap().parse().unwrap();
        let dd: f64 = out["priceDenominator"].as_str().unwrap().parse().unwrap();
        assert!((n / dd - 1.0 / 300.0).abs() < 1e-6, "{n}/{dd}");
        // Asking about another asset with this record is refused.
        assert!(check_token(&"01".repeat(32), &d).is_err());
    }

    fn manifest() -> Manifest {
        Manifest {
            schema: 1,
            kind: MediaKind::Token,
            name: "Moon Dog".into(),
            symbol: Some("MOON".into()),
            description: "A test token.".into(),
            website: Some("https://example.org/moon".into()),
            image: None,
        }
    }

    #[test]
    fn metadata_must_match_its_commitment() {
        let m = manifest();
        let text = String::from_utf8(m.canonical_bytes().unwrap()).unwrap();
        let hash = m.hash().unwrap();
        assert_eq!(check_metadata(&hash, &text, MediaKind::Token).unwrap(), m);
        // A different name under the same hash is refused.
        let fake = text.replace("Moon Dog", "Moon Cat");
        assert!(check_metadata(&hash, &fake, MediaKind::Token).is_err());
        // Wrong kind, unknown fields, reserved ticker.
        assert!(check_metadata(&hash, &text, MediaKind::Nft).is_err());
        let extra = text.replace("\"schema\":1", "\"schema\":1,\"x\":1");
        assert!(check_metadata(&hash, &extra, MediaKind::Token).is_err());
        let mut noid = manifest();
        noid.symbol = Some("NOID".into());
        assert!(noid.hash().is_err());
        // Invisible characters in a name.
        let mut sneaky = manifest();
        sneaky.name = "Moon\u{200b}Dog".into();
        assert!(sneaky.hash().is_err());
    }

    #[test]
    fn metadata_hash_matches_official_construction() {
        // blake3(domain || canonical JSON || "\n"), as noid_gui/src/assets/media.rs.
        let m = manifest();
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.starts_with("{\"schema\":1,\"kind\":\"token\",\"name\":\"Moon Dog\",\"symbol\":\"MOON\""));
        let mut h = blake3::Hasher::new();
        h.update(b"Parano1d/native-metadata/v1\0");
        h.update(json.as_bytes());
        h.update(b"\n");
        assert_eq!(m.hash().unwrap(), h.finalize().to_hex().to_string());
    }

    #[test]
    fn websites() {
        assert!(valid_website("https://parano1d.org"));
        assert!(valid_website("https://a.example/path?q=1#x"));
        assert!(!valid_website("http://parano1d.org"));
        assert!(!valid_website("https://user:pw@parano1d.org"));
        assert!(!valid_website("https://"));
        assert!(!valid_website("javascript:alert(1)"));
        assert!(!valid_website("https://bad host.org"));
    }

    #[test]
    fn image_file_is_checked() {
        let dir = std::env::temp_dir().join(format!("noid-assets-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.png");
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&64u32.to_be_bytes());
        png.extend_from_slice(&32u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        std::fs::write(&path, &png).unwrap();
        let image = MediaImage {
            hash: content_hash(IMAGE_DOMAIN, &png),
            media_type: "image/png".into(),
            width: 64,
            height: 32,
            bytes: png.len() as u32,
        };
        check_image_file(&path, &image).unwrap();
        let mut wrong = image.clone();
        wrong.width = 65;
        assert!(check_image_file(&path, &wrong).is_err());
        let mut wrong = image.clone();
        wrong.hash = "00".repeat(32);
        assert!(check_image_file(&path, &wrong).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
