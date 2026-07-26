import { processMqttMessage } from '../src/iot/bridge.ts';

async function main() {
  try {
    // Simulate malformed JSON payload from device
    await processMqttMessage('solargrid/meters/test-meter/usage', Buffer.from('not-json'));
    console.log('OK: malformed payload handled without throwing');
    process.exit(0);
  } catch (err) {
    console.error('ERROR: processMqttMessage threw an exception', err);
    process.exit(2);
  }
}

main();
