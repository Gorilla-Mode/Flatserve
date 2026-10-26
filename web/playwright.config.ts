import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173/flatserve/',
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'],
    },
  },
  webServer: [
    { command: 'dotnet run --project ../Flatserve --no-build --launch-profile http --urls http://localhost:5221',
      url: 'http://localhost:5221/fgb/feature/0', reuseExistingServer: !process.env.CI },
    { command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort --base /flatserve/',
      url: 'http://127.0.0.1:4173/flatserve/', reuseExistingServer: !process.env.CI },
  ],
});
