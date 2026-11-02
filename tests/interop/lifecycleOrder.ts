// The order of handlers on every lifecycle event of the plug-in's services, read in a running Obsidian: each handler
// list is reached through the `use` property of its bound function. Handlers are named by their function name
// ("<anonymous>" for inline ones) and priority; equal names keep their place in the list.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const BASELINE = resolve('test/fixtures/lifecycle-order.plugin.json');

/** Evaluated inside Obsidian; returns the JSON of { "<service>.<event>": ["<priority> <name>", ...] }. */
export const DUMP_LIFECYCLE = `
  const hub=app.plugins.plugins['tabularium'].core.services;
  const services={};
  for(let proto=Object.getPrototypeOf(hub);proto&&proto!==Object.prototype;proto=Object.getPrototypeOf(proto))
    for(const key of Object.getOwnPropertyNames(proto)){
      const descriptor=Object.getOwnPropertyDescriptor(proto,key);
      if(!descriptor?.get||key in services) continue;
      try{const value=hub[key];if(value&&typeof value==='object') services[key]=value;}catch{}
    }
  const order={};
  for(const [serviceName,service] of Object.entries(services)){
    const keys=new Set();
    for(let target=service;target&&target!==Object.prototype;target=Object.getPrototypeOf(target)) for(const key of Object.getOwnPropertyNames(target)) keys.add(key);
    for(const key of [...keys].sort()){
      let value;try{value=service[key];}catch{continue;}
      const map=typeof value==='function'?value.use?._callbackMap:undefined;
      if(!(map instanceof Map)||map.size===0) continue;
      order[serviceName+'.'+key]=[...map.entries()].sort((a,b)=>a[1][0]-b[1][0]||a[1][1]-b[1][1]).map(([callback,[priority]])=>priority+' '+(callback.name||'<anonymous>'));
    }
  }
  return JSON.stringify(order);
`;

/** Compares with the committed baseline, or writes it when UPDATE_LIFECYCLE_BASELINE is set. Returns the differences. */
export async function compareLifecycle(order: Record<string, string[]>): Promise<string[]> {
  if (process.env.UPDATE_LIFECYCLE_BASELINE) {
    await writeFile(BASELINE, JSON.stringify(order, null, 2) + '\n');
    return [];
  }
  const baseline = JSON.parse(await readFile(BASELINE, 'utf8')) as Record<string, string[]>;
  const differences: string[] = [];
  for (const event of new Set([...Object.keys(baseline), ...Object.keys(order)])) {
    const before = JSON.stringify(baseline[event] ?? []);
    const after = JSON.stringify(order[event] ?? []);
    if (before !== after) differences.push(`${event}\n  before ${before}\n  after  ${after}`);
  }
  return differences;
}
