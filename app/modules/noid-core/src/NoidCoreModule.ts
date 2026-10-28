import { NativeModule, requireNativeModule } from 'expo';

declare class NoidCoreModule extends NativeModule<{}> {
  /** Calls the Rust wallet core. Returns a JSON envelope string. */
  call(method: string, argsJson: string): Promise<string>;
  /** Copy text flagged as sensitive (hidden from clipboard previews). False if unavailable. */
  copySensitive?(text: string): boolean;
}

export default requireNativeModule<NoidCoreModule>('NoidCore');
