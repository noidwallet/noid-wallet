// Re-export the native module. On web, it will be resolved to NoidCoreModule.web.ts
// and on native platforms to NoidCoreModule.ts
export { default } from './src/NoidCoreModule';
export * from './src/NoidCore.types';
