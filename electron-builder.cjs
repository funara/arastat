/**
 * electron-builder configuration (moved out of electron-builder.yml so the
 * auto-update feed URL can be injected at build time instead of living in
 * the repo).
 *
 * ARASTAT_UPDATE_URL — public base URL of the update channel (the generic
 * provider prefix that serves latest.yml + the versioned installer).
 * Release builds get it from CI as a repository secret. For local release
 * builds put it in a gitignored environment file or export it manually.
 *
 * When the variable is unset (forks, PR smoke builds, plain local packaging)
 * the publish config is omitted entirely: electron-builder then bakes no
 * app-update.yml into the app and in-app auto-update stays disabled.
 * Changelog and manual-download links always point at
 * github.com/funara/ara-stats-release regardless of the feed.
 */

const { existsSync } = require('node:fs')

const updateUrl = process.env.ARASTAT_UPDATE_URL

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.funara.arastat',
  productName: 'ARAStat',
  copyright: `Copyright © ${new Date().getFullYear()} Adhi Rahmadian (adhirahmadian.id)`,
  asar: false,
  directories: {
    output: 'release',
  },
  files: ['out/**', 'package.json'],
  // The main process resolves app.getAppPath()/engine. With asar disabled,
  // placing this extra resource under resources/app/engine preserves that seam
  // while leaving the Python executable outside an archive.
  extraResources: [
    {
      from: 'engine',
      to: 'app/engine',
      filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc', '!**/.gitignore', '!**/.lock'],
    },
  ],
  win: {
    icon: existsSync('build/icon.ico') ? 'build/icon.ico' : 'src/renderer/public/icon.png',
    target: ['nsis', 'portable'],
  },
}

if (updateUrl) {
  config.publish = [
    {
      provider: 'generic',
      url: updateUrl.replace(/\/+$/, ''),
      channel: 'latest',
    },
  ]
}

module.exports = config
