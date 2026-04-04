import fs from 'fs-extra'
import path from 'path'
import unzipper from 'unzipper'
import * as cheerio from 'cheerio'
import { glob } from 'glob'
import axios from 'axios'
import archiver from 'archiver'
import sharp from 'sharp'

const PAGE_MAP = {
  '480x320/ad.html': { width: 480, height: 320 },
  '300x250/ad.html': { width: 300, height: 250 },
  '728x90/ad.html':  { width: 728, height: 90  },
  '160x600/ad.html': { width: 160, height: 600 },
  '320x50/ad.html':  { width: 320, height: 50  },
  '300x600/ad.html': { width: 300, height: 600 }
}

const BLOCKED_SCRIPTS = ['webflow.js', 'webflow.com']

async function unzipWebflow(zipPath, extractPath) {
  await fs.ensureDir(extractPath)
  await fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: extractPath }))
    .promise()
}

async function loadAllCss(extractedPath) {
  const files = await glob('**/*.css', { cwd: extractedPath, absolute: true })
  const parts = []
  for (const f of files) parts.push(await fs.readFile(f, 'utf8'))
  return parts.join('\n')
}

function collectSlots($, adRoot) {
  const slots = []
  const slotValues = {}
  adRoot.find('[data-slot]').addBack('[data-slot]').each((_, el) => {
    const name = $(el).attr('data-slot')
    if (!name || slots.includes(name)) return
    slots.push(name)
    const tag = $(el).get(0).tagName.toLowerCase()
    if (tag === 'img') {
      slotValues[name] = $(el).attr('src') || ''
    } else {
      slotValues[name] = $(el).html() || ''
    }
  })
  return { slots, slotValues }
}

async function bundleInlineFetchScripts($, outDir) {
  const scripts = $('script:not([src])')
  for (let i = 0; i < scripts.length; i++) {
    const el = scripts.eq(i)
    const content = el.html() || ''
    const urlMatch = content.match(/['"]([^'"]+\.txt)['"]/)
    if (!urlMatch) continue
    const url = urlMatch[1]
    const fname = `documents/${path.basename(url.split('?')[0]).replace(/^[a-f0-9]+_/, '')}`
    const updatedContent = content.replace(urlMatch[0], `"${fname}"`)
    el.html(updatedContent)
  }
}

async function bundleExternalScripts($, outDir) {
  const bundled = []
  const tags = $('script[src]')
  for (let i = 0; i < tags.length; i++) {
    const el = tags.eq(i)
    const src = el.attr('src') || ''
    if (!src.startsWith('http')) { el.remove(); continue }
    const srcLower = src.toLowerCase()
    const isBlocked = BLOCKED_SCRIPTS.some(b => srcLower.includes(b))
    if (isBlocked) { el.remove(); continue }
    const fname = `vendor-${path.basename(src.split('?')[0])}`
    try {
      const res = await axios.get(src, { responseType: 'arraybuffer', timeout: 15000 })
      await fs.writeFile(path.join(outDir, fname), res.data)
      el.attr('src', fname)
      el.removeAttr('crossorigin')
      el.removeAttr('integrity')
      bundled.push({ original: src, local: fname })
    } catch (err) {
      console.warn(`Could not download ${src}: ${err.message}`)
      el.remove()
    }
  }
  return bundled
}

async function processPage(htmlPath, allCss, extractedPath, templatesPath) {
  const baseName = path.relative(extractedPath, htmlPath).replace(/\\/g, '/')
  const meta = PAGE_MAP[baseName]
  if (!meta) return null
  const sizeKey = `${meta.width}x${meta.height}`

  const $ = cheerio.load(await fs.readFile(htmlPath, 'utf8'))
  const adRoot = $('.ad-root').first()
  if (!adRoot.length) return null

  const outDir = path.join(templatesPath, sizeKey)
  await fs.ensureDir(outDir)

  for (const folder of ['images', 'documents', 'fonts']) {
    const src = path.join(extractedPath, folder)
    if (await fs.pathExists(src)) await fs.copy(src, path.join(outDir, folder))
  }

  const docsOutDir = path.join(outDir, 'documents')
  if (await fs.pathExists(docsOutDir)) {
    const docFiles = await fs.readdir(docsOutDir)
    for (const f of docFiles) {
      if (/^[a-f0-9]+_/.test(f)) await fs.remove(path.join(docsOutDir, f))
    }
  }

  const fixedCss = allCss.replace(/url\(['"]?\.\.\/([^'")]+)['"]?\)/g, "url('$1')")

  $('img[src]').each((_, el) => {
    const src = $(el).attr('src') || ''
    if (src.startsWith('../')) $(el).attr('src', src.replace('../', ''))
  })
  $('link[href]').each((_, el) => {
    const href = $(el).attr('href') || ''
    if (href.startsWith('../')) $(el).attr('href', href.replace('../', ''))
  })
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || ''
    if (src.startsWith('../')) $(el).attr('src', src.replace('../', ''))
  })

  await bundleInlineFetchScripts($, outDir)
  const bundled = await bundleExternalScripts($, outDir)
  const { slots, slotValues } = collectSlots($, adRoot)

  for (const slotName of slots) {
    const el = adRoot.find(`[data-slot="${slotName}"]`).first()
    if (!el.length) continue
    if (el.get(0).tagName.toLowerCase() === 'img') {
      el.attr('src', `{{${slotName}}}`)
      el.removeAttr('srcset')
    }
  }

  const bgColorSlots = ['bg_color', 'background_color', 'bg']
  const bgSlot = slots.find(s => bgColorSlots.includes(s))
  let style = `position:relative;overflow:hidden;width:${meta.width}px;height:${meta.height}px;`
  if (bgSlot) style += `background-color:{{${bgSlot}}};`
  adRoot.attr('style', style)

  // Inject click tag into existing clicktag-button or add overlay
  const clicktagBtn = adRoot.find('.clicktag-button')
  if (clicktagBtn.length) {
    clicktagBtn.attr('href', "javascript:void(window.open(window.clickTag||'%%CLICK_URL_UNESC%%%%DEST_URL%%','_blank'))")
    clicktagBtn.attr('style', 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:99999;cursor:pointer;display:block;')
  } else {
    adRoot.append(`<div onclick="window.open(window.clickTag||'%%CLICK_URL_UNESC%%%%DEST_URL%%','_blank')" style="position:absolute;top:0;left:0;width:100%;height:100%;cursor:pointer;z-index:9999;"></div>`)
  }

  const bodyMarkup = $.html(adRoot)
  const bodyClassColor = fixedCss.match(/\.body\s*\{[^}]*color:\s*([^;}\n]+)/s)
  const adRootColor = bodyClassColor ? bodyClassColor[1].trim() : '#fff'
  const bodyClassFont = fixedCss.match(/\.body\s*\{[^}]*font-family:\s*([^;}\n]+)/s)
  const adRootFont = bodyClassFont ? bodyClassFont[1].trim() : 'sans-serif'

  const finalCss = fixedCss +
    '\n* { box-sizing: border-box; }\nbody { margin:0; padding:0; overflow:hidden; }\n' +
    `\n.ad-root { color: ${adRootColor}; font-family: ${adRootFont}; }\n` +
    '\n.clicktag-button { pointer-events: all !important; cursor: pointer !important; }\n' +
    '\n.ad-root > *:not(.clicktag-button) { pointer-events: none; }\n'

  const inlineScriptTags = []
  $('script:not([src])').each((_, el) => {
    const content = $(el).html() || ''
    if (content.trim()) inlineScriptTags.push(`<script>\n${content}\n</script>`)
  })

  const externalScriptTags = bundled
    .map(b => `  <script src="${b.local}"></script>`).join('\n')

  const finalHtml =
    `<!doctype html>\n<html lang="en">\n<head>\n` +
    `  <meta charset="UTF-8">\n` +
    `  <meta name="ad.size" content="width=${meta.width},height=${meta.height}">\n` +
    `  <title>Banner ${meta.width}x${meta.height}</title>\n` +
    `  <link rel="stylesheet" href="styles.css">\n` +
    `${externalScriptTags}\n` +
    `</head>\n` +
    `<body style="margin:0;padding:0;overflow:hidden;">\n` +
    `${bodyMarkup}\n` +
    `${inlineScriptTags.join('\n')}\n` +
    `</body>\n</html>`

  await fs.writeFile(path.join(outDir, 'index.html'), finalHtml, 'utf8')
  await fs.writeFile(path.join(outDir, 'styles.css'), finalCss, 'utf8')
  await fs.writeJson(path.join(outDir, 'manifest.json'), {
    size: sizeKey, width: meta.width, height: meta.height,
    slots, slotValues, bundled: bundled.map(b => b.local),
    generated: new Date().toISOString()
  }, { spaces: 2 })

  return { sizeKey, outDir, slots }
}

async function compressImages(dir) {
  const images = await glob('**/*.{jpg,jpeg,png}', { cwd: dir, absolute: true })
  for (const imgPath of images) {
    try {
      const ext = path.extname(imgPath).toLowerCase()
      const tmp = imgPath + '.tmp'
      if (ext === '.png') {
        await sharp(imgPath)
          .png({ compressionLevel: 9, quality: 80 })
          .toFile(tmp)
      } else {
        await sharp(imgPath)
          .jpeg({ quality: 70, progressive: true })
          .toFile(tmp)
      }
      await fs.move(tmp, imgPath, { overwrite: true })
    } catch (err) {
      console.warn(`Could not compress ${imgPath}: ${err.message}`)
    }
  }
}

async function zipDirectory(sourceDir, zipPath) {
  await fs.ensureDir(path.dirname(zipPath))
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(sourceDir, false)
    archive.finalize()
  })
}

export async function processWebflowZip(zipPath, tmpDir) {
  const extractedPath = path.join(tmpDir, 'extracted')
  const templatesPath = path.join(tmpDir, 'templates')
  const outputPath    = path.join(tmpDir, 'output.zip')

  await unzipWebflow(zipPath, extractedPath)

  const allCss = await loadAllCss(extractedPath)
  const all = await glob('**/*.html', { cwd: extractedPath, absolute: true })
  const pages = all.filter(f => {
    const rel = path.relative(extractedPath, f).replace(/\\/g, '/')
    return PAGE_MAP[rel]
  })

  if (!pages.length) throw new Error('No banner pages found in ZIP')

  for (const p of pages) {
    await processPage(p, allCss, extractedPath, templatesPath)
  }

  // Compress images before zipping
  await compressImages(templatesPath)

  // Zip all processed templates together
  await zipDirectory(templatesPath, outputPath)

  // Check file size and warn if over 600KB
  const stats = await fs.stat(outputPath)
  const sizeKB = stats.size / 1024
  const oversized = sizeKB > 600

  return { outputPath, oversized, sizeKB: Math.round(sizeKB) }
}