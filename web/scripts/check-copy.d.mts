export declare const RULES: Array<[string, RegExp]>;
export declare const DECOR: Set<string>;
export declare const OLD_WORDS: Array<[string, RegExp]>;
export declare function tsPieces(src: string): Array<[number, string, boolean]>;
export declare function cssPieces(src: string): Array<[number, string]>;
export declare function copyHits(file: string, src: string): string[];
export declare function oldWordHits(file: string, src: string): string[];
export declare function titleHits(file: string, src: string): string[];
export declare function run(root: string): number;
