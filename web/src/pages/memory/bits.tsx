import type { MemorySource } from '../../domain';
import { SRC } from './model';
import styles from './Memory.module.css';

/** The pipeline page's source square: one ink per source, 推断 hatched. */
export const SrcGlyph = ({ src }: { src: MemorySource }) => <i className={styles.glyph} data-src={SRC[src].key} aria-hidden="true" />;
