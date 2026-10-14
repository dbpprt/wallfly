import { join } from 'node:path';
import { privateDirectory, replacePrivateFile } from './files.js';

export type PairingOutput = (qr: string, directory: string) => Promise<void>;

export const printPairingQr = async (
  qr: string, directory: string,
  print: (text: string) => void = (text) => { process.stdout.write(text); },
): Promise<void> => {
  privateDirectory(directory);
  const { default: QRCode } = await import('qrcode');
  const png = await QRCode.toBuffer(qr, { type: 'png' });
  const ascii = await QRCode.toString(qr, { type: 'terminal', small: true });
  const path = join(directory, 'pairing.png');
  replacePrivateFile(path, png);
  print(`Pair with WhatsApp > Linked devices. QR PNG: ${path}\n${ascii}\n`);
};
