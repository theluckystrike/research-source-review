import { describe, expect, it } from 'vitest';
import vectors from './vectors/research-source-review.json';
import { runScenario, type Scenario } from '../src/review';

describe('golden acceptance vectors', () => {
	for (const vector of vectors.cases) it(vector.name, () => {
		expect(runScenario(vector.args[0] as Scenario)).toEqual(vector.expected);
	});
});
