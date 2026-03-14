import * as fs from 'fs';

/**
 * Returns true if the file contains a null byte in the first 8 KB.
 * Null bytes don't appear in plain-text files but are common in binary formats.
 */
export async function isBinaryFile(fsPath: string): Promise<boolean> {
    const BUF_SIZE = 8192;
    const buf = Buffer.allocUnsafe(BUF_SIZE);
    const handle = await fs.promises.open(fsPath, 'r');
    try {
        const { bytesRead } = await handle.read(buf, 0, BUF_SIZE, 0);
        return buf.slice(0, bytesRead).includes(0x00);
    } finally {
        await handle.close();
    }
}
