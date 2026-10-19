import { NativeModule, requireNativeModule } from 'expo';

declare class NoidCoreModule extends NativeModule<{}> {
  /** Calls the Rust wallet core. Returns a JSON envelope string. */
  call(method: string, argsJson: string): Promise<string>;
}

export default requireNativeModule<NoidCoreModule>('NoidCore');
