const nodeMajorVersion = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const isWindowsNode25OrNewer = process.platform === 'win32' && nodeMajorVersion >= 25;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack(config) {
    if (isWindowsNode25OrNewer) {
      // Windows + Node 25 会让 Next 14 内置 webpack 的持久化缓存快照失败。
      // 改用内存缓存可避开 PackFileCacheStrategy，同时只影响本地开发/构建性能。
      config.cache = { type: 'memory' };
    }

    return config;
  },
};

export default nextConfig;
