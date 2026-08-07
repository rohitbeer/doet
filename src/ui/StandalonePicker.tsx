import React, { useState } from 'react';
import { render, useApp, useInput, useStdout } from 'ink';
import { Picker, type PickerItem } from './Picker.js';

interface Props {
  title: string;
  items: PickerItem[];
  initial: number;
  resolve: (value: string | null) => void;
}

function StandalonePicker({ title, items, initial, resolve }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [index, setIndex] = useState(Math.max(0, Math.min(initial, items.length - 1)));

  useInput((char, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % items.length);
    else if (key.return) {
      resolve(items[index]?.id ?? null);
      exit();
    } else if (key.escape || (key.ctrl && char === 'c')) {
      resolve(null);
      exit();
    }
  });

  return (
    <Picker
      title={title}
      items={items}
      index={index}
      width={Math.max(40, Math.min(stdout.columns ?? 80, 100))}
    />
  );
}

/** A short launch-time choice, before either long-lived TUI is mounted. */
export async function chooseOne(
  title: string,
  items: PickerItem[],
  initial = 0,
): Promise<string | null> {
  if (items.length === 0) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return items[initial]?.id ?? items[0]!.id;

  let settle!: (value: string | null) => void;
  const selected = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  const app = render(
    <StandalonePicker title={title} items={items} initial={initial} resolve={settle} />,
    { exitOnCtrlC: false },
  );
  const value = await selected;
  await app.waitUntilExit();
  return value;
}
