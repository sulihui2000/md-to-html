#!/usr/bin/env node

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const matter = require('gray-matter');
const { marked } = require('marked');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const BACKUPS_DIR = path.join(PROJECT_ROOT, 'backups');
const TMP_PUBLISHED_DIR = path.join(PROJECT_ROOT, '.tmp-published');
const TMP_DIST_DIR = path.join(PROJECT_ROOT, '.tmp-dist');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'blog.config.json');
const CONFIG_EXAMPLE_PATH = path.join(PROJECT_ROOT, 'blog.config.example.json');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

marked.use({
  mangle: false,
  headerIds: false
});

async function main() {
  const command = process.argv[2];

  try {
    if (command === 'publish') {
      await publish();
    } else if (command === 'build') {
      await build();
    } else {
      printUsageAndExit();
    }
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}

async function publish() {
  const config = await loadConfig();
  await ensureProjectFolders();
  await cleanTempDirs();

  const draftFiles = await scanDrafts(config);
  console.log(`Draft Markdown files found: ${draftFiles.markdown.length}`);

  if (draftFiles.markdown.length === 0) {
    console.log('No draft articles found. Add Markdown files to the Obsidian blogs/drafts folder and try again.');
    return;
  }

  const publishPlan = await validateAndPlanReadyDrafts(config, draftFiles);

  if (publishPlan.ready.length === 0) {
    console.log('No ready draft articles to publish.');
    printSkippedDrafts(publishPlan);
    await reportDraftRemainders(config);
    return;
  }

  const stagedSource = await stagePublishedForPublish(config, publishPlan);
  const buildResult = await buildSite(config, { sourceRoot: stagedSource });

  await commitPublish(config, publishPlan);

  try {
    const replacement = await replaceDistWithBackup(buildResult.tempDist);
    await fs.rm(TMP_PUBLISHED_DIR, { recursive: true, force: true });
    console.log(`Generated site: ${path.relative(PROJECT_ROOT, path.join(DIST_DIR, 'index.html'))}`);
    if (replacement.backupPath) {
      console.log(`Previous dist backup: ${path.relative(PROJECT_ROOT, replacement.backupPath)}`);
    }
    await reportDraftRemainders(config);
  } catch (error) {
    throw new Error(`Published source files were updated, but dist replacement failed. Run "npm run build" after fixing this issue.\n${error.message}`);
  }
}

async function build() {
  const config = await loadConfig();
  await ensureProjectFolders();
  await cleanTempDirs();
  const buildResult = await buildSite(config, { sourceRoot: config.publishedDir });
  const replacement = await replaceDistWithBackup(buildResult.tempDist);

  console.log(`Published articles loaded: ${buildResult.posts.length}`);
  if (buildResult.posts.length === 0) {
    console.log('Generated empty-state homepage.');
  }
  console.log(`Generated site: ${path.relative(PROJECT_ROOT, path.join(DIST_DIR, 'index.html'))}`);
  if (replacement.backupPath) {
    console.log(`Previous dist backup: ${path.relative(PROJECT_ROOT, replacement.backupPath)}`);
  }
}

async function loadConfig() {
  const hasEnvPaths = process.env.OBSIDIAN_BLOG_DRAFTS && process.env.OBSIDIAN_BLOG_PUBLISHED;
  if (!fsSync.existsSync(CONFIG_PATH) && !hasEnvPaths) {
    throw new Error(`Missing blog.config.json. Copy ${path.basename(CONFIG_EXAMPLE_PATH)} to blog.config.json and set your Obsidian vault path.`);
  }

  let config = {};
  if (fsSync.existsSync(CONFIG_PATH)) {
    let raw;
    try {
      raw = await fs.readFile(CONFIG_PATH, 'utf8');
    } catch (error) {
      throw new Error(`Could not read blog.config.json: ${error.message}`);
    }

    try {
      config = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in blog.config.json: ${error.message}`);
    }
  }

  const vaultRoot = process.env.OBSIDIAN_VAULT_ROOT || config.obsidianVaultRoot;
  const draftsOverride = process.env.OBSIDIAN_BLOG_DRAFTS;
  const publishedOverride = process.env.OBSIDIAN_BLOG_PUBLISHED;

  if (!vaultRoot && (!draftsOverride || !publishedOverride)) {
    throw new Error('blog.config.json must set obsidianVaultRoot, or both OBSIDIAN_BLOG_DRAFTS and OBSIDIAN_BLOG_PUBLISHED must be provided.');
  }

  const resolved = {
    siteTitle: config.siteTitle || 'Engineering Notes',
    obsidianVaultRoot: vaultRoot ? path.resolve(vaultRoot) : '',
    draftsDir: resolveObsidianPath(draftsOverride || config.draftsDir, vaultRoot),
    publishedDir: resolveObsidianPath(publishedOverride || config.publishedDir, vaultRoot)
  };

  if (resolved.obsidianVaultRoot.includes('<') || resolved.draftsDir.includes('<') || resolved.publishedDir.includes('<')) {
    throw new Error('blog.config.json still contains placeholder paths. Set your Obsidian vault path before running the publisher.');
  }

  return resolved;
}

function resolveObsidianPath(value, vaultRoot) {
  if (!value) {
    throw new Error('blog.config.json must set draftsDir and publishedDir.');
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  if (!vaultRoot) {
    throw new Error(`Relative Obsidian path "${value}" requires obsidianVaultRoot.`);
  }
  return path.resolve(vaultRoot, value);
}

async function ensureProjectFolders() {
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
}

async function cleanTempDirs() {
  await fs.rm(TMP_PUBLISHED_DIR, { recursive: true, force: true });
  await fs.rm(TMP_DIST_DIR, { recursive: true, force: true });
}

async function ensureReadableDirectory(dir, label) {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      throw new Error(`${label} is not a directory: ${dir}`);
    }
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${dir}. Check blog.config.json.`);
  }
}

async function scanDrafts(config) {
  await ensureReadableDirectory(config.draftsDir, 'Obsidian draftsDir');
  const entries = await fs.readdir(config.draftsDir, { withFileTypes: true });
  const markdown = [];
  const assets = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    const filePath = path.join(config.draftsDir, entry.name);
    if (ext === '.md') {
      markdown.push(filePath);
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      assets.push(filePath);
    }
  }

  return { markdown, assets };
}

async function validateAndPlanReadyDrafts(config, draftFiles) {
  await fs.mkdir(config.publishedDir, { recursive: true });
  const skipped = [];
  const readyPosts = [];
  const usedSlugs = await loadExistingSlugs(config.publishedDir);
  const draftImageRefsByNotReady = new Set();
  const parsedDrafts = [];

  for (const filePath of draftFiles.markdown) {
    const parsed = await parseDraftMatter(filePath);
    parsedDrafts.push(parsed);
    if (parsed.data.status !== 'ready') {
      skipped.push({ filePath, status: parsed.data.status || 'missing' });
      for (const image of extractLocalImages(parsed.content)) {
        draftImageRefsByNotReady.add(normalizeAssetRef(image));
      }
    }
  }

  for (const draft of parsedDrafts) {
    if (draft.data.status !== 'ready') {
      continue;
    }
    if (!draft.data.slug) {
      throw new Error(`Ready draft is missing required slug front matter: ${draft.filePath}\nExample:\n---\nstatus: ready\nslug: example-post\n---`);
    }

    const plannedSlug = createUniqueSlug(sanitizeSlug(String(draft.data.slug)), usedSlugs);
    usedSlugs.add(plannedSlug);

    const imageRefs = extractLocalImages(draft.content);
    const assetPlans = [];
    let nextContent = draft.content;

    for (const imageRef of imageRefs) {
      const assetPlan = await planAsset(config, imageRef, draftImageRefsByNotReady);
      assetPlans.push(assetPlan);
      if (assetPlan.rewrittenRef && assetPlan.rewrittenRef !== imageRef) {
        nextContent = replaceMarkdownImageRefs(nextContent, imageRef, assetPlan.rewrittenRef);
      }
    }

    readyPosts.push({
      sourcePath: draft.filePath,
      filename: path.basename(draft.filePath),
      data: draft.data,
      content: nextContent,
      slug: plannedSlug,
      destinationPath: path.join(config.publishedDir, `${plannedSlug}.md`),
      assetPlans
    });
  }

  printSkippedDrafts({ skipped });
  for (const post of readyPosts) {
    console.log(`Ready draft: ${path.basename(post.sourcePath)} -> ${post.slug}.md`);
    for (const asset of post.assetPlans) {
      console.log(`Image: ${asset.originalRef} (${asset.sourceLabel}) -> ${path.basename(asset.publishedPath)}`);
      if (asset.renamed) {
        console.log(`Asset renamed to avoid conflict: ${asset.originalName} -> ${path.basename(asset.publishedPath)}`);
      }
    }
  }

  const referencedDraftAssets = new Set();
  for (const post of readyPosts) {
    for (const asset of post.assetPlans) {
      if (asset.source === 'draft') {
        referencedDraftAssets.add(path.resolve(asset.sourcePath).toLowerCase());
      }
    }
  }
  const unreferencedAssets = draftFiles.assets.filter((assetPath) => !referencedDraftAssets.has(path.resolve(assetPath).toLowerCase()));

  return {
    ready: readyPosts,
    skipped,
    unreferencedAssets
  };
}

async function parseDraftMatter(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { filePath, ...matter(raw) };
  } catch (error) {
    throw new Error(`Invalid front matter or unreadable Markdown file: ${filePath}\n${error.message}`);
  }
}

async function loadExistingSlugs(sourceRoot) {
  const used = new Set();
  const entries = await safeReaddir(sourceRoot);
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') {
      continue;
    }
    const parsed = await parseMarkdownPost(path.join(sourceRoot, entry.name), { requireSlug: true, sourceRoot, usedSlugs: used });
    used.add(parsed.slug);
  }
  return used;
}

async function planAsset(config, imageRef, draftImageRefsByNotReady) {
  const normalizedRef = normalizeAssetRef(imageRef);
  const imageName = path.basename(normalizedRef);
  const draftPath = path.join(config.draftsDir, normalizedRef);
  const publishedPath = path.join(config.publishedDir, normalizedRef);
  const publishedByBasename = path.join(config.publishedDir, imageName);

  if (fsSync.existsSync(draftPath)) {
    const destination = await resolveAssetDestination(config.publishedDir, draftPath, imageName);
    const shouldCopy = draftImageRefsByNotReady.has(normalizedRef);
    return {
      source: 'draft',
      sourceLabel: shouldCopy ? 'draftsDir, copied because a not-ready draft also references it' : 'draftsDir',
      sourcePath: draftPath,
      originalRef: imageRef,
      originalName: imageName,
      publishedPath: destination.path,
      rewrittenRef: destination.name,
      renamed: destination.name !== imageName,
      operation: shouldCopy ? 'copy' : 'move'
    };
  }

  if (fsSync.existsSync(publishedPath)) {
    return {
      source: 'published',
      sourceLabel: 'publishedDir',
      sourcePath: publishedPath,
      originalRef: imageRef,
      originalName: imageName,
      publishedPath,
      rewrittenRef: imageRef,
      renamed: false,
      operation: 'reuse'
    };
  }

  if (fsSync.existsSync(publishedByBasename)) {
    return {
      source: 'published',
      sourceLabel: 'publishedDir',
      sourcePath: publishedByBasename,
      originalRef: imageRef,
      originalName: imageName,
      publishedPath: publishedByBasename,
      rewrittenRef: imageName,
      renamed: normalizedRef !== imageName,
      operation: 'reuse'
    };
  }

  throw new Error(`Missing image "${imageRef}" referenced by a ready draft. Put it in draftsDir or publishedDir before publishing.`);
}

async function resolveAssetDestination(publishedDir, sourcePath, imageName) {
  let candidateName = imageName;
  let candidatePath = path.join(publishedDir, candidateName);

  if (!fsSync.existsSync(candidatePath)) {
    return { name: candidateName, path: candidatePath };
  }

  if (await sameFileContent(sourcePath, candidatePath)) {
    return { name: candidateName, path: candidatePath };
  }

  const parsed = path.parse(imageName);
  const hash = await shortHash(sourcePath);
  candidateName = `${parsed.name}-${hash}${parsed.ext}`;
  candidatePath = path.join(publishedDir, candidateName);
  let counter = 2;
  while (fsSync.existsSync(candidatePath) && !(await sameFileContent(sourcePath, candidatePath))) {
    candidateName = `${parsed.name}-${counter}${parsed.ext}`;
    candidatePath = path.join(publishedDir, candidateName);
    counter += 1;
  }
  return { name: candidateName, path: candidatePath };
}

async function stagePublishedForPublish(config, publishPlan) {
  await fs.rm(TMP_PUBLISHED_DIR, { recursive: true, force: true });
  await fs.mkdir(TMP_PUBLISHED_DIR, { recursive: true });
  await copyDirectoryContents(config.publishedDir, TMP_PUBLISHED_DIR);

  for (const post of publishPlan.ready) {
    const stagedPostPath = path.join(TMP_PUBLISHED_DIR, path.basename(post.destinationPath));
    const raw = matter.stringify(post.content, { ...post.data, slug: post.slug });
    await fs.writeFile(stagedPostPath, raw, 'utf8');
    for (const asset of post.assetPlans) {
      if (asset.source === 'draft') {
        await fs.copyFile(asset.sourcePath, path.join(TMP_PUBLISHED_DIR, path.basename(asset.publishedPath)));
      }
    }
  }

  return TMP_PUBLISHED_DIR;
}

async function commitPublish(config, publishPlan) {
  for (const post of publishPlan.ready) {
    await fs.mkdir(path.dirname(post.destinationPath), { recursive: true });
    const raw = matter.stringify(post.content, { ...post.data, slug: post.slug });
    await fs.writeFile(post.destinationPath, raw, 'utf8');
    await fs.rm(post.sourcePath, { force: true });
    console.log(`Moved Markdown into publishedDir: ${path.basename(post.destinationPath)}`);

    for (const asset of post.assetPlans) {
      if (asset.source !== 'draft') {
        continue;
      }
      await fs.mkdir(path.dirname(asset.publishedPath), { recursive: true });
      if (asset.operation === 'copy') {
        await fs.copyFile(asset.sourcePath, asset.publishedPath);
        console.log(`Copied asset into publishedDir: ${path.basename(asset.publishedPath)}`);
      } else {
        await fs.rename(asset.sourcePath, asset.publishedPath);
        console.log(`Moved asset into publishedDir: ${path.basename(asset.publishedPath)}`);
      }
    }
  }
}

async function buildSite(config, { sourceRoot }) {
  await fs.rm(TMP_DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP_DIST_DIR, 'posts'), { recursive: true });
  await fs.mkdir(path.join(TMP_DIST_DIR, 'assets'), { recursive: true });

  const posts = await loadPublishedPosts(sourceRoot);
  posts.sort((a, b) => b.createdDate - a.createdDate || a.title.localeCompare(b.title));

  await copyContentAssets(posts, TMP_DIST_DIR);
  await writeBuildToTemp(config, posts, TMP_DIST_DIR);
  await validateTempDist(posts, TMP_DIST_DIR);

  return { tempDist: TMP_DIST_DIR, posts };
}

async function loadPublishedPosts(sourceRoot) {
  await fs.mkdir(sourceRoot, { recursive: true });
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  const mdFiles = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.md')
    .map((entry) => path.join(sourceRoot, entry.name));
  const usedSlugs = new Set();
  const posts = [];

  for (const filePath of mdFiles) {
    posts.push(await parseMarkdownPost(filePath, { requireSlug: true, sourceRoot, usedSlugs }));
  }

  return posts;
}

async function parseMarkdownPost(filePath, { requireSlug, sourceRoot, usedSlugs }) {
  let parsed;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    parsed = matter(raw);
  } catch (error) {
    throw new Error(`Invalid front matter or unreadable Markdown file: ${filePath}\n${error.message}`);
  }

  const data = parsed.data || {};
  if (requireSlug && !data.slug) {
    throw new Error(`Published Markdown file is missing required slug front matter: ${filePath}`);
  }

  const baseSlug = sanitizeSlug(String(data.slug || path.basename(filePath, '.md')));
  const slug = createUniqueSlug(baseSlug, usedSlugs);
  usedSlugs.add(slug);

  const title = extractTitle(parsed.content) || path.basename(filePath, '.md');
  const dateInfo = await resolveCreatedDate(filePath, data.created);
  if (dateInfo.warning) {
    console.warn(dateInfo.warning);
  }

  const contentWithoutTitle = removeFirstH1(parsed.content);
  const toc = createTableOfContents(contentWithoutTitle);
  const imageRefs = extractLocalImages(parsed.content);
  const markdownWithIds = applyHeadingIds(contentWithoutTitle, toc);
  const images = [];

  for (const imageRef of imageRefs) {
    const normalized = normalizeAssetRef(imageRef);
    const imagePath = path.join(sourceRoot, normalized);
    const basenamePath = path.join(sourceRoot, path.basename(normalized));
    const publishedPath = fsSync.existsSync(imagePath) ? imagePath : basenamePath;
    if (!fsSync.existsSync(publishedPath)) {
      throw new Error(`Missing image during build. Article: ${filePath}; image: ${imageRef}`);
    }
    images.push({
      original: imageRef,
      publishedPath,
      outputName: path.basename(publishedPath),
      outputPath: path.join(TMP_DIST_DIR, 'assets', path.basename(publishedPath))
    });
  }

  return {
    sourcePath: filePath,
    slug,
    title,
    created: dateInfo.display,
    createdDate: dateInfo.date,
    status: data.status || '',
    target: data.target || '',
    tags: normalizeTags(data.tags),
    toc,
    images,
    imageRefs,
    markdown: markdownWithIds
  };
}

function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? stripMarkdownInline(match[1]).trim() : '';
}

function removeFirstH1(markdown) {
  return markdown.replace(/^#\s+.+(?:\r?\n)+/m, '');
}

function createTableOfContents(markdown) {
  const headings = [];
  const headingPattern = /^(#{2,6})\s+(.+)$/gm;
  let match;
  while ((match = headingPattern.exec(markdown)) !== null) {
    headings.push({
      level: match[1].length,
      text: stripMarkdownInline(match[2]).trim()
    });
  }

  if (headings.length === 0) {
    return [];
  }

  const shallowest = Math.min(...headings.map((heading) => heading.level));
  const usedIds = new Set();
  return headings
    .filter((heading) => heading.level === shallowest || heading.level === shallowest + 1)
    .map((heading) => ({
      level: heading.level,
      id: createHeadingId(heading.text, usedIds),
      text: heading.text,
      depth: heading.level === shallowest ? 0 : 1
    }));
}

function rewriteMarkdownImages(markdown, imageRefs, prefix) {
  let next = markdown;
  for (const imageRef of imageRefs) {
    const outputRef = `${prefix}${path.basename(normalizeAssetRef(imageRef))}`;
    next = replaceMarkdownImageRefs(next, imageRef, outputRef);
    next = replaceWikiImageRefs(next, imageRef, outputRef);
  }
  return next;
}

function replaceMarkdownImageRefs(markdown, originalRef, nextRef) {
  const escaped = escapeRegExp(originalRef);
  return markdown.replace(new RegExp(`(!\\[[^\\]]*\\]\\()${escaped}(\\))`, 'g'), `$1${nextRef}$2`);
}

function replaceWikiImageRefs(markdown, originalRef, nextRef) {
  const escaped = escapeRegExp(originalRef);
  return markdown.replace(new RegExp(`!\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`, 'g'), `![](${nextRef})`);
}

function applyHeadingIds(markdown, toc) {
  if (toc.length === 0) {
    return markdown;
  }

  const pending = toc.map((item) => ({ ...item }));
  return markdown.replace(/^(#{2,6})\s+(.+)$/gm, (full, hashes, rawText) => {
    const level = hashes.length;
    const text = stripMarkdownInline(rawText).trim();
    const index = pending.findIndex((item) => item.level === level && item.text === text);
    if (index === -1) {
      return full;
    }
    const [item] = pending.splice(index, 1);
    return `<h${level} id="${escapeHtml(item.id)}">${escapeHtml(text)}</h${level}>`;
  });
}

function extractLocalImages(markdown) {
  const refs = new Set();
  const markdownImagePattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = markdownImagePattern.exec(markdown)) !== null) {
    const ref = cleanImageRef(match[1]);
    if (isLocalImageRef(ref)) {
      refs.add(ref);
    }
  }

  const wikilinkPattern = /!\[\[([^\]]+)\]\]/g;
  while ((match = wikilinkPattern.exec(markdown)) !== null) {
    const ref = cleanImageRef(match[1].split('|')[0]);
    if (isLocalImageRef(ref)) {
      refs.add(ref);
    }
  }

  return [...refs];
}

function cleanImageRef(ref) {
  return decodeURI(String(ref).trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0]);
}

function isLocalImageRef(ref) {
  if (!ref || /^(https?:)?\/\//i.test(ref) || /^(data|mailto):/i.test(ref)) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(path.extname(ref).toLowerCase());
}

function normalizeAssetRef(ref) {
  return ref.replace(/\\/g, '/').replace(/^\.?\//, '');
}

async function copyContentAssets(posts, tempDist) {
  for (const post of posts) {
    for (const image of post.images) {
      await fs.copyFile(image.publishedPath, path.join(tempDist, 'assets', image.outputName));
    }
  }
}

async function writeBuildToTemp(config, posts, tempDist) {
  await fs.writeFile(path.join(tempDist, 'styles.css'), renderStyles(), 'utf8');
  await fs.writeFile(path.join(tempDist, 'index.html'), renderHomePage(config, posts), 'utf8');

  for (const post of posts) {
    await fs.writeFile(path.join(tempDist, 'posts', `${post.slug}.html`), renderPostPage(config, post, posts), 'utf8');
  }
}

async function validateTempDist(posts, tempDist) {
  if (!fsSync.existsSync(path.join(tempDist, 'index.html'))) {
    throw new Error(`Temporary build is invalid: missing ${path.join(tempDist, 'index.html')}`);
  }
  for (const post of posts) {
    if (!fsSync.existsSync(path.join(tempDist, 'posts', `${post.slug}.html`))) {
      throw new Error(`Temporary build is invalid: missing post page for ${post.slug}`);
    }
    for (const image of post.images) {
      if (!fsSync.existsSync(path.join(tempDist, 'assets', image.outputName))) {
        throw new Error(`Temporary build is invalid: missing asset ${image.outputName}`);
      }
    }
  }
}

async function replaceDistWithBackup(tempDist) {
  let backupPath = null;
  if (fsSync.existsSync(DIST_DIR)) {
    await fs.mkdir(BACKUPS_DIR, { recursive: true });
    backupPath = path.join(BACKUPS_DIR, `dist-${timestampForBackup()}`);
    await fs.rename(DIST_DIR, backupPath);
  }
  await fs.rename(tempDist, DIST_DIR);
  return { backupPath };
}

function renderHomePage(config, posts) {
  const latest = posts[0];
  const body = latest
    ? `<div class="reader-grid">${renderDirectory(config, posts, latest.slug, '')}<main class="article-surface">${renderArticle(latest, 'assets/')}</main></div>`
    : `<main class="empty-state"><h1>${escapeHtml(config.siteTitle)}</h1><p>No articles yet. Add a ready Markdown file to the Obsidian blogs/drafts folder and run npm run publish.</p></main>`;
  return renderLayout({
    title: config.siteTitle,
    body,
    cssPath: 'styles.css'
  });
}

function renderPostPage(config, post, posts) {
  const body = `<div class="reader-grid">${renderDirectory(config, posts, post.slug, '../')}<main class="article-surface">${renderArticle(post, '../assets/')}</main></div>`;
  return renderLayout({
    title: `${post.title} - ${config.siteTitle}`,
    body,
    cssPath: '../styles.css'
  });
}

function renderLayout({ title, body, cssPath }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${cssPath}">
</head>
<body>
${body}
</body>
</html>
`;
}

function renderDirectory(config, posts, currentSlug, rootPrefix) {
  const countText = `${posts.length} ${posts.length === 1 ? 'article' : 'articles'}`;
  const items = posts.map((post) => {
    const current = post.slug === currentSlug ? ' aria-current="page"' : '';
    return `<li><a${current} href="${rootPrefix}posts/${post.slug}.html">${escapeHtml(post.title)}</a></li>`;
  }).join('\n');

  return `<aside class="site-panel">
  <header class="site-header">
    <a class="site-title" href="${rootPrefix}index.html">${escapeHtml(config.siteTitle)}</a>
    <span class="article-count">${escapeHtml(countText)}</span>
  </header>
  <section class="article-list" aria-label="Articles">
    <h2>Articles</h2>
    <ol>${items}</ol>
  </section>
</aside>`;
}

function renderArticle(post, assetPrefix = 'assets/') {
  const tags = post.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');
  const html = marked.parse(rewriteMarkdownImages(post.markdown, post.imageRefs, assetPrefix));
  return `<article class="post">
  <header class="post-header">
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    <h1>${escapeHtml(post.title)}</h1>
    <p>${escapeHtml(post.created)}</p>
  </header>
  ${post.toc.length ? renderToc(post.toc) : ''}
  <div class="post-body">${html}</div>
</article>`;
}

function renderToc(toc) {
  const items = toc.map((item) => `<li class="${item.depth ? 'nested' : ''}"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`).join('');
  return `<nav class="toc" aria-label="Contents"><h2>Contents</h2><ol>${items}</ol></nav>`;
}

function renderStyles() {
  return `:root {
  --page-bg: #f4f8ff;
  --surface: #ffffff;
  --surface-soft: #edf5ff;
  --border: #d0e2ff;
  --border-strong: #a6c8ff;
  --text: #161616;
  --text-muted: #525252;
  --accent: #0f62fe;
  --accent-soft: #78a9ff;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--page-bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  line-height: 1.75;
}

a {
  color: var(--accent);
}

.reader-grid {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: 24px;
  max-width: 1240px;
  margin: 0 auto;
  padding: 18px;
}

.site-panel {
  position: sticky;
  top: 18px;
  align-self: start;
  max-height: calc(100vh - 36px);
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(15 98 254 / 8%);
}

.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px;
  border-bottom: 1px solid var(--border);
}

.site-title {
  color: var(--text);
  font-weight: 700;
  text-decoration: none;
}

.article-count {
  flex: 0 0 auto;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  padding: 2px 10px;
  color: var(--accent);
  font-size: 12px;
  background: var(--surface-soft);
}

.article-list {
  padding: 16px;
}

.article-list h2,
.toc h2 {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--text-muted);
  text-transform: uppercase;
}

.article-list ol,
.toc ol {
  list-style: none;
  margin: 0;
  padding: 0;
}

.article-list a {
  display: block;
  border-left: 3px solid transparent;
  border-radius: 6px;
  padding: 10px 12px;
  color: var(--text);
  text-decoration: none;
}

.article-list a:hover,
.article-list a[aria-current="page"] {
  border-left-color: var(--accent);
  background: var(--surface-soft);
  color: var(--accent);
}

.article-surface,
.empty-state {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(15 98 254 / 8%);
}

.empty-state {
  max-width: 760px;
  margin: 48px auto;
  padding: 36px;
}

.post {
  padding: 34px;
}

.post-header {
  border-left: 5px solid var(--accent);
  padding-left: 18px;
  margin-bottom: 26px;
}

.post-header h1 {
  margin: 8px 0;
  font-size: clamp(28px, 4vw, 44px);
  line-height: 1.2;
  letter-spacing: 0;
}

.post-header p {
  margin: 0;
  color: var(--text-muted);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tags span {
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  padding: 2px 10px;
  color: var(--accent);
  font-size: 13px;
  background: var(--surface-soft);
}

.toc {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin: 0 0 28px;
  padding: 16px;
  background: var(--surface-soft);
}

.toc li {
  margin: 6px 0;
}

.toc li.nested {
  padding-left: 18px;
}

.post-body {
  max-width: 760px;
}

.post-body h2,
.post-body h3,
.post-body h4 {
  margin-top: 32px;
  line-height: 1.35;
}

.post-body p,
.post-body li {
  color: var(--text);
}

.post-body img {
  display: block;
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin: 24px 0;
  padding: 8px;
  background: var(--surface-soft);
}

.post-body code {
  border-radius: 4px;
  padding: 2px 5px;
  background: var(--surface-soft);
}

.post-body pre {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: var(--surface-soft);
}

.post-body pre code {
  padding: 0;
  background: transparent;
}

@media (max-width: 820px) {
  .reader-grid {
    display: block;
    padding: 12px;
  }

  .site-panel {
    position: static;
    max-height: none;
    margin-bottom: 16px;
    overflow: visible;
  }

  .post {
    padding: 22px;
  }
}
`;
}

async function resolveCreatedDate(filePath, value) {
  let date = value ? new Date(value) : null;
  let warning = '';

  if (value && Number.isNaN(date.getTime())) {
    warning = `Invalid created date in ${filePath}; using file modified time.`;
    date = null;
  }

  if (!date) {
    const stat = await fs.stat(filePath);
    date = stat.mtime;
  }

  return {
    date,
    display: date.toISOString().slice(0, 10),
    warning
  };
}

function normalizeTags(tags) {
  if (!tags) {
    return [];
  }
  if (Array.isArray(tags)) {
    return tags.map(String).filter(Boolean);
  }
  return String(tags).split(',').map((tag) => tag.trim()).filter(Boolean);
}

function sanitizeSlug(slug) {
  return slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'post';
}

function createUniqueSlug(slug, usedSlugs) {
  let candidate = slug;
  let counter = 2;
  while (usedSlugs.has(candidate)) {
    candidate = `${slug}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function createHeadingId(text, usedIds) {
  const base = sanitizeSlug(text);
  const id = createUniqueSlug(base, usedIds);
  usedIds.add(id);
  return id;
}

function stripMarkdownInline(text) {
  return String(text)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~#]/g, '');
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function copyDirectoryContents(from, to) {
  const entries = await safeReaddir(from);
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(dest, { recursive: true });
      await copyDirectoryContents(src, dest);
    } else if (entry.isFile()) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  }
}

async function sameFileContent(a, b) {
  if (!fsSync.existsSync(a) || !fsSync.existsSync(b)) {
    return false;
  }
  const [hashA, hashB] = await Promise.all([shortHash(a, 64), shortHash(b, 64)]);
  return hashA === hashB;
}

async function shortHash(filePath, length = 8) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, length);
}

function timestampForBackup() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function printSkippedDrafts(plan) {
  if (!plan.skipped || plan.skipped.length === 0) {
    return;
  }
  for (const skipped of plan.skipped) {
    console.log(`Skipped draft (${skipped.status}): ${path.basename(skipped.filePath)}`);
  }
}

async function reportDraftRemainders(config) {
  const entries = await safeReaddir(config.draftsDir);
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  if (files.length > 0) {
    console.log(`Files left in draftsDir: ${files.join(', ')}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function printUsageAndExit() {
  console.log('Usage: node scripts/blog.js <publish|build>');
  process.exitCode = 1;
}

main();
