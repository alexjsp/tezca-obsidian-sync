// E2E_FILTER=core runs only specs/*core*.e2e.ts
const filter = process.env.E2E_FILTER;
module.exports = {
	"node-option": ["import=tsx"],
	require: ["support/hooks.ts"],
	spec: [filter ? `specs/*${filter}*.e2e.ts` : "specs/*.e2e.ts"],
	timeout: 240000,
	slow: 30000,
	exit: true,
};
