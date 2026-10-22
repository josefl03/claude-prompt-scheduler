# Notice

`prompt-scheduler` started as a personal mod and borrows ideas and code from two projects:

- [longmaba/no-limit](https://github.com/longmaba/no-limit), MIT License, Copyright (c) 2026 longmaba. The reset-time reading (`findReset`), the polling resume and the retry backoff come from it. Its license text:

  > Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

- The `auto-resume` mod in [seanrobertwright/claude-mods](https://github.com/seanrobertwright/claude-mods), the starting point of the usage-limit resume and its band above the prompt.

The prompt grammar (`schedule.ts`), the queue rules (`queue.ts`), the per-session queue, the date-time menu and the tests are original to this repository.

This project is not affiliated with Anthropic. "Claude" and "Claude Code" belong to their owners.
