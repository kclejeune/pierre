`lib/diff3.ts` ports the three-way merge from
[node-diff3](https://github.com/bhousel/node-diff3) (`diff3Merge` and
`diff3MergeRegions`): the hunk grouping, conflict bounds, and region output.
DiffsHub replaced its two-way LCS diff with jsdiff's Myers implementation and an
edit-length cap, but the merge logic remains derived from node-diff3. The
original MIT license text is included below for attribution.

Original license for `node-diff3`:

```
The MIT License (MIT)

diff function extracted from Project Synchrotron.

For more detail please visit:
- https://leastfixedpoint.com/tonyg/kcbbs/projects/synchrotron.html
- https://github.com/tonyg/synchrotron

Copyright (c) 2006, 2008 Tony Garnock-Jones <tonyg@lshift.net>
Copyright (c) 2006, 2008 LShift Ltd. <query@lshift.net>
Copyright (c) 2019-2026 Bryan Housel <bhousel@gmail.com>

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation files
(the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software,
and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
