# Client dependency notices

## First-party license scope

Copyright (c) 2026 lihy. First-party Client code in new candidates after the existing 0.1.81 release is licensed under Apache License 2.0; see LICENSE. Existing 0.1.81 and earlier releases retain their original MIT terms and unchanged assets. This does not license Server software or access to the hosted service. Dependency notices and licenses below remain unchanged.

Regional builds embed the complete notices for the bundled Apache-2.0 EigenPal DOCX editor (1.9.0), React and their runtime dependencies in the distributed main.js. See scripts/docx-dependencies.mjs for the reviewed package list and package-lock.json for the fixed versions. The build uses the MIT option for PizZip and JSZip and the Apache-2.0 option for DOMPurify. No EigenPal Pro or telemetry package is enabled.

Word opening passwords use the SheetJS CFB container parser, its checksum dependencies and Noble Hashes. Their package licenses are included in the same build notices.

Secure Markdown editing uses the CodeMirror editor interfaces provided by Obsidian and bundles MIT-licensed CodeMirror editing commands, the Lezer Markdown parser, and their runtime dependencies. Their complete package notices are embedded in the distributed `main.js`.

## node-diff3 3.2.1

Source: https://github.com/bhousel/node-diff3

### The MIT License (MIT)

diff function extracted from Project Synchrotron.

For more detail please visit:
- https://leastfixedpoint.com/tonyg/kcbbs/projects/synchrotron.html
- https://github.com/tonyg/synchrotron

Copyright (c) 2006, 2008 Tony Garnock-Jones &lt;tonyg@lshift.net&gt;<br/>
Copyright (c) 2006, 2008 LShift Ltd. &lt;query@lshift.net&gt;<br/>
Copyright (c) 2019-2026 Bryan Housel &lt;bhousel@gmail.com&gt;<br/>

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


## @noble/ed25519 3.2.0

Source: https://github.com/paulmillr/noble-ed25519

The MIT License (MIT)

Copyright (c) 2019 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## fflate 0.8.3

Source: https://github.com/101arrowz/fflate

MIT License

Copyright (c) 2026 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
## Authentication provider brand marks

Google's G mark and GitHub's Invertocat identify the corresponding sign-in providers. These marks remain the trademarks of their respective owners and are not relicensed under this project's software license. Bundled vector geometry comes from Google's https://fonts.gstatic.com/s/i/productlogos/googleg/v6/24px.svg and GitHub's official https://brand.github.com/GitHub_Logos.zip (SVG/GitHub_Invertocat_Black.svg). No endorsement is implied.
