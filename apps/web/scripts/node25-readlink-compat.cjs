'use strict';

/**
 * 为 Windows + Node 25 的 Next.js 构建注入 fs.readlink 兼容层。
 *
 * 背景：Node 25 在 Windows 下对普通文件调用 readlink 时，可能错误返回 EISDIR。
 * Next 14 内置的 webpack 会把这类探测性 readlink 当成构建流程的一部分，
 * 从而导致 `next build` 在并非符号链接的普通文件上意外失败。
 *
 * 兼容策略：
 * 1. 仅在 Windows 且 Node 主版本 >= 25 时启用；
 * 2. 当 readlink 因 EISDIR 失败时，再用 lstat 确认目标是否真的是符号链接；
 * 3. 若目标只是普通文件，则返回 `undefined`，让上游按“不是 symlink”继续处理。
 *
 * 该补丁只服务于本地构建入口，不影响业务代码或生产运行逻辑。
 */

const fs = require('fs');
const nodeFs = require('node:fs');
const fsPromises = require('fs/promises');
const nodeFsPromises = require('node:fs/promises');

const nodeMajorVersion = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const shouldApplyCompat = process.platform === 'win32' && nodeMajorVersion >= 25;

/**
 * 判断当前错误是否属于 Node 25 在 Windows 上对普通文件 readlink 的异常误报。
 *
 * @param {NodeJS.ErrnoException | null | undefined} error readlink 返回的错误。
 * @returns {boolean} 是否需要回退到 lstat 做二次确认。
 */
function isRegularFileReadlinkError(error) {
  return Boolean(error && error.code === 'EISDIR');
}

if (shouldApplyCompat && !global.__AI_NOVEL_NODE25_READLINK_COMPAT__) {
  global.__AI_NOVEL_NODE25_READLINK_COMPAT__ = true;

  const originalReadlink = fs.readlink.bind(fs);
  const originalReadlinkSync = fs.readlinkSync.bind(fs);
  const originalPromisesReadlink = fsPromises.readlink.bind(fsPromises);

  /**
   * 包装异步 readlink：若普通文件被误报为 EISDIR，则按“非符号链接”处理。
   *
   * @param {string | Buffer | URL} path 目标路径。
   * @param {BufferEncoding | { encoding?: BufferEncoding | null } | Function | undefined} options 读取选项。
   * @param {(error: NodeJS.ErrnoException | null, linkString?: string | Buffer) => void} callback 回调函数。
   */
  function patchedReadlink(path, options, callback) {
    const resolvedCallback = typeof options === 'function' ? options : callback;
    const resolvedOptions = typeof options === 'function' ? undefined : options;

    originalReadlink(path, resolvedOptions, (error, result) => {
      if (!isRegularFileReadlinkError(error)) {
        return resolvedCallback(error, result);
      }

      fs.lstat(path, (lstatError, stats) => {
        if (!lstatError && stats && !stats.isSymbolicLink()) {
          return resolvedCallback(null, undefined);
        }

        return resolvedCallback(error);
      });
    });
  }

  /**
   * 包装同步 readlink：仅在普通文件误报时吞掉异常并返回 undefined。
   *
   * @param {string | Buffer | URL} path 目标路径。
   * @param {BufferEncoding | { encoding?: BufferEncoding | null } | undefined} options 读取选项。
   * @returns {string | Buffer | undefined} 解析出的链接目标；普通文件时返回 undefined。
   */
  function patchedReadlinkSync(path, options) {
    try {
      return originalReadlinkSync(path, options);
    } catch (error) {
      if (!isRegularFileReadlinkError(error)) {
        throw error;
      }

      const stats = fs.lstatSync(path);
      if (!stats.isSymbolicLink()) {
        return undefined;
      }

      throw error;
    }
  }

  /**
   * 包装 Promise 版 readlink，兼容 webpack/Next 可能使用的 promise 风格调用。
   *
   * @param {string | Buffer | URL} path 目标路径。
   * @param {BufferEncoding | { encoding?: BufferEncoding | null } | undefined} options 读取选项。
   * @returns {Promise<string | Buffer | undefined>} 链接目标；普通文件时返回 undefined。
   */
  async function patchedPromisesReadlink(path, options) {
    try {
      return await originalPromisesReadlink(path, options);
    } catch (error) {
      if (!isRegularFileReadlinkError(error)) {
        throw error;
      }

      const stats = await fsPromises.lstat(path);
      if (!stats.isSymbolicLink()) {
        return undefined;
      }

      throw error;
    }
  }

  fs.readlink = patchedReadlink;
  nodeFs.readlink = patchedReadlink;

  fs.readlinkSync = patchedReadlinkSync;
  nodeFs.readlinkSync = patchedReadlinkSync;

  fsPromises.readlink = patchedPromisesReadlink;
  nodeFsPromises.readlink = patchedPromisesReadlink;

  if (fs.promises) {
    fs.promises.readlink = patchedPromisesReadlink;
  }

  if (nodeFs.promises) {
    nodeFs.promises.readlink = patchedPromisesReadlink;
  }
}