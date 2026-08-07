/**
 * Verifies the terminal actually changes hands.
 *
 * This is the one link in the pane handover that needs a real TTY: Ink has to
 * step back, the child has to own the terminal, and Ink has to redraw after.
 *
 *   script -q /dev/null npx tsx scripts/probe-suspend.tsx
 */
import React, { useEffect, useState } from 'react';
import { spawn } from 'node:child_process';
import { Box, Text, render, useApp } from 'ink';

function Probe() {
  const { exit, suspendTerminal } = useApp();
  const [stage, setStage] = useState('ink is drawing');

  useEffect(() => {
    void (async () => {
      await new Promise((r) => setTimeout(r, 200));
      setStage('handing the terminal over…');
      await new Promise((r) => setTimeout(r, 200));

      await suspendTerminal(async () => {
        await new Promise<void>((resolve) => {
          // `sh -c` so the child writes to and reads the inherited tty.
          const child = spawn('sh', ['-c', 'echo "CHILD OWNS THE TERMINAL"; tty; sleep 0.2'], {
            stdio: 'inherit',
          });
          child.on('close', () => resolve());
        });
      });

      setStage('ink is back and redrew');
      await new Promise((r) => setTimeout(r, 300));
      exit();
    })();
  }, [exit, suspendTerminal]);

  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>stage: {stage}</Text>
    </Box>
  );
}

const app = render(<Probe />);
await app.waitUntilExit();
process.stdout.write('probe-suspend finished\n');
