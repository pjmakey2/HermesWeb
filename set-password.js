// Uso: npm run set-password   — define o cambia la contraseña (cierra todas las sesiones web)
import readline from 'node:readline';
import { setPassword, AUTH_FILE } from './auth.js';

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); }; // no mostrar lo tecleado
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

if (!process.stdin.isTTY) {
  console.error('Ejecuta este comando en una terminal interactiva.');
  process.exit(1);
}
const p1 = await ask('Nueva contraseña: ');
if (p1.length < 10) { console.error('Mínimo 10 caracteres.'); process.exit(1); }
const p2 = await ask('Repetir contraseña: ');
if (p1 !== p2) { console.error('No coinciden.'); process.exit(1); }
await setPassword(p1);
console.log(`Contraseña guardada en ${AUTH_FILE}. Las sesiones web abiertas quedaron cerradas.`);
console.log('Si el servidor está corriendo, toma el cambio sin reiniciar.');
