import type pg from 'pg';

/** Either the pool (auto-commit, one-off reads) or a client inside a transaction. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;
