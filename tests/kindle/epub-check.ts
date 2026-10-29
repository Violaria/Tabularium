// Builds sample EPUBs with the plug-in's generator and validates them with EPUBCheck; any error fails.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildEpub, type EpubImage } from '../../apps/obsidian/src/features/tabularium/epub.ts';
import { renderNote } from '../../apps/obsidian/src/features/tabularium/render.ts';
import { epubErrors } from './epubcheck.ts';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const note = `---
tags: [示例]
---
#Tabularium #测试

开头一段中文，包含 **加粗**、*斜体*、\`行内代码\` 和 [外部链接](https://example.com/?a=1&b=2)。

## 第一节：安装
1. 第一步
2. 第二步：执行命令

\`\`\`bash
sudo apt install nginx && echo "<ok>" > /tmp/x
\`\`\`

### 小节
| 参数 | 值 |
| --- | --- |
| 端口 | \`10000\` |
| 域名 | a & b |

## 第二节：图片与链接
![[配图.png]]
![[示意.svg]]
![远程图片](https://example.com/a.png)
见 [[另一篇#锚点|另一篇笔记]]，以及 <div onclick="x">原始 HTML</div>。
> 引用一段文字
%%这段是注释%%

- [ ] 待办
- 列表项 1 < 2
`;

async function check(name: string, data: Uint8Array, directory: string) {
  const file = join(directory, `${name}.epub`);
  await writeFile(file, data);
  return epubErrors(file);
}

const directory = await mkdtemp(join(tmpdir(), 'tabularium-epub-'));
try {
  const images: EpubImage[] = [];
  const resolveImage = (target: string) => {
    if (!target.endsWith('.png')) return undefined;
    const href = `images/image-${images.length + 1}.png`;
    images.push({ href, mediaType: 'image/png', data: png });
    return href;
  };
  const base = { language: 'zh', modified: new Date() };
  const single = renderNote(note, resolveImage);
  let errors = await check('single', buildEpub({ ...base, title: '示例笔记', identifier: 'urn:uuid:3f2504e0-4f89-41d3-9a0c-0305e82c3301', images: [...images],
    chapters: [{ title: '示例笔记', ...single }] }), directory);
  images.length = 0;
  const chapters = [
    { title: '总述', group: undefined },
    { title: '部署笔记', group: '服务运维' },
    { title: '故障排查', group: '服务运维' },
    { title: '组网设计', group: '网络工程' },
  ].map(c => ({ ...c, ...renderNote(note, resolveImage) }));
  errors += await check('folder', buildEpub({ ...base, title: 'Commentarii', identifier: 'urn:uuid:3f2504e0-4f89-41d3-9a0c-0305e82c3302', images, chapters }), directory);
  if (errors) process.exitCode = 1;
  else console.log('EPUBCheck passed for both books.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
