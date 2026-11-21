export declare function inside(rel: string): boolean;
export declare const EXCEPTIONS: Array<[string, string, string]>;
export declare function imports(src: string): Array<[number, string, 'import' | 'glob']>;
export declare function run(srcDir: string): { violations: string[]; stale: string[] };
