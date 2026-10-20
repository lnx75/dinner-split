import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyArchive, safeError } from './backup.mjs';

export { verifyArchive };
const invokedFile = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    // --verify ARCHIVE [--restore-to NEW_DIR] only. Restoring into an existing
    // folder is forbidden, so this tool cannot overwrite a running installation.
    if (argv[0] !== '--verify' || !argv[1] || (argv.length !== 2 && (argv.length !== 4 || argv[2] !== '--restore-to' || !argv[3]))) throw new Error('invalid options');
    const result = await verifyArchive(argv[1], { restoreTo: argv[3] });
    console.log(JSON.stringify({ ok: true, restored: argv.length === 4, ...result }));
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
  }
}
