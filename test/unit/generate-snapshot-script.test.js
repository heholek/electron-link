const assert = require('assert')
const fs = require('fs')
const generateSnapshotScript = require('../../src/generate-snapshot-script')
const Module = require('module')
const path = require('path')
const temp = require('temp').track()
const TransformCache = require('../../src/transform-cache')

suite('generateSnapshotScript({baseDirPath, mainPath})', () => {
  let previousRequire

  beforeEach(() => {
    previousRequire = Module.prototype.require
  })

  afterEach(() => {
    Module.prototype.require = previousRequire
    temp.cleanupSync()
  })

  test('simple integration test', async () => {
    const baseDirPath = __dirname
    const mainPath = path.resolve(baseDirPath, '..', 'fixtures', 'module-1', 'index.js')
    const cachePath = temp.mkdirSync()

    {
      const cache = new TransformCache(cachePath, 'invalidation-key')
      await cache.loadOrCreate()
      const snapshotScript = await generateSnapshotScript(cache, {
        baseDirPath,
        mainPath,
        shouldExcludeModule: (modulePath) => modulePath.endsWith('b.js')
      })
      eval(snapshotScript)
      snapshotResult.setGlobals(global, process, {}, {}, require)
      assert(!global.moduleInitialized)
      assert.equal(global.initialize(), 'abx/ybAd')
      assert(global.moduleInitialized)
      assert.equal((await cache._allKeys()).size, 9)
      await cache.dispose()
    }

    {
      const cache = new TransformCache(cachePath, 'invalidation-key')
      await cache.loadOrCreate()
      await cache.put({
        filePath: mainPath,
        original: fs.readFileSync(mainPath, 'utf8'),
        transformed: 'global.initialize = () => "cached"',
        requires: []
      })
      const snapshotScript = await generateSnapshotScript(cache, {
        baseDirPath,
        mainPath,
        shouldExcludeModule: (modulePath) => modulePath.endsWith('b.js')
      })
      eval(snapshotScript)
      snapshotResult.setGlobals(global, process, {}, {}, require)
      assert.equal(global.initialize(), 'cached')
      assert.equal((await cache._allKeys()).size, 3)
      await cache.dispose()
    }

    {
      const cache = new TransformCache(cachePath, 'a-new-invalidation-key')
      await cache.loadOrCreate()
      const snapshotScript = await generateSnapshotScript(cache, {
        baseDirPath,
        mainPath,
        shouldExcludeModule: (modulePath) => modulePath.endsWith('b.js')
      })
      eval(snapshotScript)
      snapshotResult.setGlobals(global, process, {}, {}, require)
      assert.equal(global.initialize(), 'abx/ybAd')
      assert.equal((await cache._allKeys()).size, 9)
      await cache.dispose()
    }
  })

  test('cyclic requires', async () => {
    const baseDirPath = __dirname
    const mainPath = path.resolve(baseDirPath, '..', 'fixtures', 'cyclic-require', 'a.js')
    const cachePath = temp.mkdirSync()

    {
      const cache = new TransformCache(cachePath, 'invalidation-key')
      await cache.loadOrCreate()
      const snapshotScript = await generateSnapshotScript(cache, {
        baseDirPath,
        mainPath,
        shouldExcludeModule: (modulePath) => modulePath.endsWith('d.js') || modulePath.endsWith('e.js')
      })
      eval(snapshotScript)
      const cachedRequires = []
      const uncachedRequires = []
      Module.prototype.require = function (module) {
        if (module.includes('babel')) {
          return previousRequire(module)
        } else {
          const absoluteFilePath = Module._resolveFilename(module, this, false)
          const relativeFilePath = path.relative(mainPath, absoluteFilePath)
          let cachedModule = snapshotResult.customRequire.cache[relativeFilePath]
          if (cachedModule) {
            cachedRequires.push(relativeFilePath)
          } else {
            uncachedRequires.push(relativeFilePath)
            cachedModule = {exports: Module._load(module, this, false)}
            snapshotResult.customRequire.cache[relativeFilePath] = cachedModule
          }

          return cachedModule.exports
        }
      }
      snapshotResult.setGlobals(global, process, {}, {}, require)
      assert.deepEqual(global.cyclicRequire(), {a: 'a', b: 'b', d: 'd', e: 'e'})
      assert.deepEqual(uncachedRequires, ['../d.js', '../e.js', '../d.js'])
      assert.deepEqual(cachedRequires, ['../e.js'])
      await cache.dispose()
    }
  })

  test('auxiliary data', async () => {
    const cache = new TransformCache(temp.mkdirSync(), 'invalidation-key')
    await cache.loadOrCreate()
    const auxiliaryData = {
      a: 1,
      b: '2',
      c: [3, 4, 5],
      d: {
        e: 6,
        f: [7],
        g: null,
        h: ''
      }
    }
    const snapshotScript = await generateSnapshotScript(cache, {
      baseDirPath: __dirname,
      mainPath: path.resolve(__dirname, '..', 'fixtures', 'module-1', 'index.js'),
      auxiliaryData,
      shouldExcludeModule: (modulePath) => false
    })
    eval(snapshotScript)
    assert.deepEqual(snapshotAuxiliaryData, auxiliaryData)
    await cache.dispose()
  })

  test('process.platform', async () => {
    const baseDirPath = __dirname
    const mainPath = path.resolve(baseDirPath, '..', 'fixtures', 'module-2', 'index.js')
    const cache = new TransformCache(temp.mkdirSync(), 'invalidation-key')
    await cache.loadOrCreate()
    const snapshotScript = await generateSnapshotScript(cache, {
      baseDirPath,
      mainPath,
      shouldExcludeModule: () => false
    })
    eval(snapshotScript)
    snapshotResult.setGlobals(global, process, {}, {}, require)
    assert.deepEqual(global.module2, {platform: process.platform})
    await cache.dispose()
  })

  test('line numbers translation', async () => {
    const baseDirPath = __dirname
    const mainPath = path.resolve(baseDirPath, '..', 'fixtures', 'module-1', 'index.js')
    const cache = new TransformCache(temp.mkdirSync(), 'invalidation-key')
    await cache.loadOrCreate()
    const snapshotScript = await generateSnapshotScript(cache, {
      baseDirPath,
      mainPath,
      shouldExcludeModule: (modulePath) => modulePath.endsWith('b.js')
    })
    eval(snapshotScript)
    snapshotResult.setGlobals(global, process, {}, {}, require)

    assert.deepEqual(snapshotResult.translateLineNumber(10), {filename: '<embedded>', lineNumber: 10})
    assert.deepEqual(snapshotResult.translateLineNumber(63), {filename: '../fixtures/module-1/index.js', lineNumber: 0})
    assert.deepEqual(snapshotResult.translateLineNumber(70), {filename: '../fixtures/module-1/index.js', lineNumber: 7})
    assert.deepEqual(snapshotResult.translateLineNumber(93), {filename: '../fixtures/module-1/dir/c.json', lineNumber: 2})
    assert.deepEqual(snapshotResult.translateLineNumber(95), {filename: '../fixtures/module-1/node_modules/a/index.js', lineNumber: 0})
    assert.deepEqual(snapshotResult.translateLineNumber(96), {filename: '../fixtures/module-1/node_modules/a/index.js', lineNumber: 1})
    assert.deepEqual(snapshotResult.translateLineNumber(99), {filename: '<embedded>', lineNumber: 99})

    await cache.dispose()
  })
})
