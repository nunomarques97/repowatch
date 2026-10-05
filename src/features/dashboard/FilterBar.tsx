// Filter chips, sort and density (DESIGN.md "Filter chips").

import type { CSSProperties } from 'react';
import type { Density } from '../../ipc';
import { FILTERS, SORTS, type Filter, type Sort } from './model';

interface FilterBarProps {
  filter: Filter;
  counts: Record<Filter, number>;
  onFilter: (filter: Filter) => void;
  sort: Sort;
  onSort: (sort: Sort) => void;
  density: Density;
  onDensity: (density: Density) => void;
}

export function FilterBar({ filter, counts, onFilter, sort, onSort, density, onDensity }: FilterBarProps) {
  return (
    <div className="filters">
      <div className="chips" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            // The lowest-priority chip hides in a small window unless it is the active one.
            className={f.id === 'branch' && filter !== 'branch' ? 'chip opt' : 'chip'}
            aria-pressed={filter === f.id}
            onClick={() => onFilter(f.id)}
          >
            {f.level && <span className="dot" style={{ '--dot': `var(--${f.level})` } as CSSProperties} />}
            {f.label}
            <span className="n">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      <span className="spacer" />
      <label className="sort">
        <span>Sort</span>
        <select value={sort} onChange={(e) => onSort(e.target.value as Sort)}>
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="seg" role="group" aria-label="Density">
        <button type="button" aria-pressed={density === 'compact'} onClick={() => onDensity('compact')}>
          Compact
        </button>
        <button type="button" aria-pressed={density === 'comfortable'} onClick={() => onDensity('comfortable')}>
          Comfortable
        </button>
      </div>
    </div>
  );
}
