import { Btn } from '../ui';
import { navigate } from './nav';
import styles from './Placeholder.module.css';

export function NotFound() {
  return (
    <section className={styles.root}>
      <h1 className={styles.title}>页面不存在</h1>
      <Btn variant="secondary" onClick={() => navigate({ page: 'home' })}>
        返回主页
      </Btn>
    </section>
  );
}
