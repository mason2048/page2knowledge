import { createApp, startBackgroundScheduler } from './app.js';

const port = Number(process.env.PAGE2KNOWLEDGE_PORT ?? 4315);
const host = process.env.PAGE2KNOWLEDGE_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

createApp().listen(port, host, () => {
  console.log(`Page2Knowledge ${process.env.NODE_ENV === 'production' ? 'service' : 'local server'}: http://${host}:${port}`);
});
startBackgroundScheduler();
