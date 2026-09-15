const { copyFile } = require('node:fs/promises')
const { join } = require('node:path')

const SESSION_HOST_EXECUTABLE = 'nodeterm-session-host.exe'

async function stageSessionHostExecutable(context, copy = copyFile) {
  if (context.packager.platform.name !== 'windows') return

  const productFilename = context.packager.appInfo.productFilename
  await copy(
    join(context.appOutDir, `${productFilename}.exe`),
    join(context.appOutDir, SESSION_HOST_EXECUTABLE)
  )
}

module.exports = stageSessionHostExecutable
module.exports.SESSION_HOST_EXECUTABLE = SESSION_HOST_EXECUTABLE
