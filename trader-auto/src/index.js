import { loadConfig } from './config.js';
import { BscExecutor } from './executor.js';
import { FourMemeSource } from './fourmeme-source.js';
import { OnchainSource } from './onchain-source.js';
import { log, logError } from './logger.js';
import { RuntimeStorage } from './storage.js';
import { TraderAutoBot } from './bot.js';

async function main() {
  const config = loadConfig();
  const storage = new RuntimeStorage(config.stateFile);
  await storage.load();

  const executor = new BscExecutor(config);
  const bot = new TraderAutoBot({
    config,
    storage,
    monitor: new FourMemeSource({ ...config.fourMeme, logBlockChunk: config.logBlockChunk }, executor.publicClient),
    onchainMonitor: new OnchainSource({ ...config.pancake, logBlockChunk: config.logBlockChunk }, executor.publicClient),
    executor,
  });

  process.on('SIGINT', () => {
    log('AUTO', '收到退出信号，准备停止');
    bot.stop();
  });

  await bot.start();
}

main().catch((error) => {
  logError('AUTO', '启动失败', error);
  process.exit(1);
});
