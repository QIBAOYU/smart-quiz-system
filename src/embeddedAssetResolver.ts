import { Image, NativeModules, PixelRatio, Platform } from 'react-native';

type SourceCodeModule = {
  getConstants?: () => {
    scriptURL?: string;
  };
};

type PackagerAsset = {
  hash?: string;
  fileHashes?: string[];
  scales?: number[];
};

type AssetSourceResolver = {
  asset?: PackagerAsset;
  fromSource: (source: string) => unknown;
};

type ResolveAssetSource = {
  setCustomSourceTransformer?: (
    transformer: (resolver: AssetSourceResolver) => unknown | null
  ) => void;
  addCustomSourceTransformer?: (
    transformer: (resolver: AssetSourceResolver) => unknown | null
  ) => void;
};

type RuntimeGlobal = typeof globalThis & {
  __ONEDAY_EMBEDDED_ASSET_RESOLVER_INSTALLED__?: boolean;
};

function getScriptURL(): string | undefined {
  const sourceCode = NativeModules.SourceCode as SourceCodeModule | undefined;
  return sourceCode?.getConstants?.().scriptURL;
}

function pickAssetHash(asset: PackagerAsset): string | null {
  if (asset.hash) return asset.hash;

  const fileHashes = asset.fileHashes;
  if (!fileHashes || fileHashes.length === 0) return null;

  const scales = asset.scales && asset.scales.length > 0 ? asset.scales : [1];
  const deviceScale = PixelRatio.get();
  const scaleIndex = scales.findIndex((scale) => scale >= deviceScale);
  const selectedIndex = scaleIndex >= 0 ? scaleIndex : scales.length - 1;

  return fileHashes[selectedIndex] ?? fileHashes[0] ?? null;
}

function installEmbeddedAssetResolver(): void {
  if (Platform.OS !== 'android') return;

  const runtimeGlobal = globalThis as RuntimeGlobal;
  if (runtimeGlobal.__ONEDAY_EMBEDDED_ASSET_RESOLVER_INSTALLED__) return;

  const scriptURL = getScriptURL();
  if (typeof scriptURL === 'string' && /^https?:\/\//.test(scriptURL)) return;

  const resolveAssetSource = Image.resolveAssetSource as ResolveAssetSource | undefined;
  if (!resolveAssetSource) return;

  const transformAssetSource = (resolver: AssetSourceResolver) => {
    const hash = resolver.asset ? pickAssetHash(resolver.asset) : null;
    if (!hash) return null;

    return resolver.fromSource(`asset:///assets/${hash}`);
  };

  if (resolveAssetSource.setCustomSourceTransformer) {
    resolveAssetSource.setCustomSourceTransformer(transformAssetSource);
  } else if (resolveAssetSource.addCustomSourceTransformer) {
    resolveAssetSource.addCustomSourceTransformer(transformAssetSource);
  } else {
    return;
  }

  runtimeGlobal.__ONEDAY_EMBEDDED_ASSET_RESOLVER_INSTALLED__ = true;
}

installEmbeddedAssetResolver();
