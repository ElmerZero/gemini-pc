'use strict';

// Small, repeatable compatibility fixes for the pinned upstream server.
// Keep these outside servidor/ so a fresh installation receives the same fixes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PATCH_ID = 'workspace-guidance-v1';
const PATCHES = [
  {
    file: 'mcp-server.js',
    replacements: [
      {
        before: "      capabilities: { tools: { listChanged: false } },\n      serverInfo: {",
        after: [
          '      capabilities: { tools: { listChanged: false } },',
          '      // Gemini PC: workspace-guidance-v1',
          '      instructions: [',
          '        \'Trabajas dentro de la carpeta que el usuario compartió en Gemini PC.\',',
          '        \'Comienza explorando con list_files({"path":"."}). El punto es la raíz compartida; las rutas relativas parten de ella, no del directorio del servidor.\',',
          '        \'No uses ".." para salir de la carpeta compartida. Si necesitas otra carpeta, pide al usuario cambiarla en Editar configuración. Los límites de acceso y los enlaces simbólicos se comprueban en cada operación.\',',
          '        \'No supongas que una carpeta usa Git. Usa las herramientas de archivos para tareas normales; consulta git_status sólo cuando la tarea necesite Git. Si isRepository es false, continúa con los archivos. No ejecutes git init salvo petición explícita del usuario.\'',
          "      ].join(' '),",
          '      serverInfo: {'
        ].join('\n')
      },
      {
        before: "description: 'Lists files and directories in a path under the allowed folders.',",
        after: "description: 'Lista archivos y carpetas dentro de la carpeta compartida. Empieza con path=\".\": es la raíz elegida por el usuario. No uses \"..\" para salir de ella; no se necesita Git para trabajar con archivos.',"
      },
      {
        before: "path: { type: 'string', description: 'Relative or allowed absolute path. Default \".\".' }",
        after: "path: { type: 'string', description: 'Ruta relativa a la carpeta compartida o ruta absoluta permitida. Usa \".\" para explorar su raíz; no uses \"..\" para salir. Predeterminado: \".\".' }"
      },
      {
        before: 'throw new Error(`Path is outside allowed roots or escapes through a symbolic link: ${rawPath}`);',
        after: 'throw new Error(`La ruta solicitada está fuera de la carpeta compartida o sale de ella mediante un enlace simbólico: ${rawPath}. Empieza con list_files({"path":"."}); "." es la raíz compartida. Para trabajar en otra carpeta, pide al usuario cambiarla en Editar configuración. (Path is outside allowed roots or escapes through a symbolic link.)`);'
      }
    ]
  },
  {
    file: 'lib/full-control-tools.js',
    replacements: [
      {
        before: "'Shows branch and working tree status for a repository.'",
        after: "'Consulta el estado Git de una carpeta sólo cuando la tarea requiera Git. Devuelve isRepository=false si no es un repositorio; en ese caso sigue trabajando con las herramientas de archivos. No inicializa Git.'"
      },
      {
        before: [
          "      case 'git_status': {",
          '        const repo = resolvedDirectory(args.repo);',
          "        return textResult(await requireScopedSuccess('git', ['-C', repo, 'status', '--short', '--branch'], scopedOpts({ repo })));",
          '      }'
        ].join('\n'),
        after: [
          "      case 'git_status': {",
          '        const repo = resolvedDirectory(args.repo);',
          '        // Gemini PC: workspace-guidance-v1',
          "        const result = await runScopedCommand('git', ['-C', repo, 'status', '--short', '--branch'], scopedOpts({ repo }));",
          "        if (!result.timed_out && result.exit_code !== 0 && /not a git repository/i.test(result.stderr || '')) {",
          '          return textResult({',
          '            isRepository: false,',
          '            repo,',
          "            message: 'Esta carpeta no es un repositorio Git. Puedes seguir leyendo y editando sus archivos con los permisos concedidos.',",
          "            nextStep: 'Usa list_files, read_file o las herramientas de archivos disponibles. No ejecutes git init salvo petición explícita del usuario.'",
          '          });',
          '        }',
          '        if (result.exit_code !== 0 || result.timed_out) {',
          "          const detail = (result.stderr || result.stdout || '').trim();",
          "          throw new Error(`git failed${result.timed_out ? ' (timeout)' : ''}${detail ? `: ${detail}` : ''}`);",
          '        }',
          '        return textResult({ ...result, isRepository: true, repo });',
          '      }'
        ].join('\n')
      },
      {
        before: [
          '      finalArgs = wrapped.args;',
          '    }',
          '    return execCommand(finalCmd, finalArgs, execOptions);'
        ].join('\n'),
        after: [
          '      finalArgs = wrapped.args;',
          '    }',
          "    if (cmd === 'git') {",
          '      // Never discover a repository above the authorized workspace.',
          "      const repo = path.resolve(execOptions.repo || execOptions.cwd || allowedRoots[0] || process.cwd());",
          '      const roots = allowedRoots.filter(root => {',
          '        const relative = path.relative(root, repo);',
          "        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));",
          '      }).sort((a, b) => a.length - b.length);',
          "      if (!roots.length) throw new Error('La carpeta Git debe estar dentro de una carpeta compartida.');",
          '      execOptions = { ...execOptions, env: {',
          '        ...execOptions.env, GIT_CEILING_DIRECTORIES: path.dirname(roots[0]),',
          '        GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,',
          '        GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,',
          "        LC_ALL: 'C', LANG: 'C'",
          '      } };',
          '    }',
          '    return execCommand(finalCmd, finalArgs, execOptions);'
        ].join('\n')
      }
    ]
  }
];

function applyServerPatches(directory) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.name !== 'mcp-server-local' || metadata.version !== '4.6.1') {
    throw new Error('No se pueden aplicar las mejoras a esta versión del motor. Se requiere MCP 4.6.1.');
  }
  // Validate every edit before changing anything; never overwrite unknown code.
  const files = PATCHES.map(patch => {
    const file = path.join(directory, patch.file);
    const original = fs.readFileSync(file, 'utf8');
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    let updated = original.replace(/\r\n/g, '\n');
    for (const { before, after } of patch.replacements) {
      if (updated.includes(after) && !updated.includes(before)) continue;
      if (updated.split(before).length !== 2) {
        throw new Error(`El motor tiene cambios incompatibles en ${patch.file}. Conserva esos cambios antes de actualizar la app.`);
      }
      updated = updated.replace(before, after);
    }
    return { file, original, updated: updated.replace(/\n/g, eol) };
  });
  const changed = [];
  for (const { file, original, updated } of files) {
    if (updated === original) continue;
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, updated, { mode: fs.statSync(file).mode & 0o777 });
      fs.renameSync(temporary, file);
      changed.push(path.relative(directory, file));
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return { id: PATCH_ID, changed };
}

module.exports = { applyServerPatches };
