import { execSync } from 'node:child_process'

const validModes = ['prod', 'main']
const mode = process.env.BUILD_MODE || 'prod'

if (!validModes.includes(mode)) {
  console.error(`BUILD_MODE 必须是 ${validModes.join(' 或 ')}，当前: ${mode}`)
  process.exit(1)
}

console.log(`使用构建环境: ${mode}`)
execSync(`npm run build:${mode}`, { stdio: 'inherit', env: process.env })
