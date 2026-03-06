import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function readEnvValue(filePath, key) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const line = raw
      .split(/\r?\n/)
      .find((item) => item.trim().startsWith(`${key}=`) && !item.trim().startsWith('#'));
    if (!line) return '';
    return line.slice(line.indexOf('=') + 1).trim();
  } catch (_) {
    return '';
  }
}

export default defineConfig(() => {
  const frontendPathKey = String(process.env.VITE_ADMIN_PATH_KEY || '').trim();
  if (!frontendPathKey) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const backendEnvPath = path.resolve(__dirname, '../backend/.env');
    const backendPathKey = readEnvValue(backendEnvPath, 'ADMIN_PATH_KEY');
    if (backendPathKey) {
      process.env.VITE_ADMIN_PATH_KEY = backendPathKey;
    }
  }

  return {
    plugins: [vue()],
    server: {
      port: 38173,
    },
  };
});