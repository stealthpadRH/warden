const ts = () => new Date().toISOString().slice(11, 19);
export const log = (scope: string, ...a: unknown[]) => console.log(ts(), `[${scope}]`, ...a);
export const warn = (scope: string, ...a: unknown[]) => console.warn(ts(), `[${scope}] !`, ...a);
