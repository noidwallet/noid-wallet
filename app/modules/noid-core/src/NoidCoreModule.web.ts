import { registerWebModule, NativeModule } from 'expo';

// NoidCoreModule is not available on the web platform.
class NoidCoreModule extends NativeModule<{}> {}

export default registerWebModule(NoidCoreModule, 'NoidCoreModule');
