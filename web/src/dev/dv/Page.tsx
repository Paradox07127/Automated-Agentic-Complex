import { ChartState } from '../../charts';
import { useDemo } from '../../shell/demo';
import { chartCatalog } from '../catalog';
import { CatalogView } from '../CatalogView';

/** Stop time shown by the error demo (fixture day, 14:31). */
const STOPPED_AT = new Date(2026, 9, 29, 14, 31).getTime();

/** `#/dv`: every chart; `?state=loading|empty|error` wraps each demo in ChartState for the other three states. */
export function DataVizPage() {
  const { state } = useDemo();
  return (
    <CatalogView
      entries={chartCatalog}
      wrap={(node) =>
        state ? (
          <ChartState state={state} emptyText="演示空态：写原因和下一步" stoppedAt={STOPPED_AT}>
            {node}
          </ChartState>
        ) : (
          node
        )
      }
    />
  );
}
