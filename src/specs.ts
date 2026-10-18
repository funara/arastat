// Analysis spec schemas (§7): the single source of truth for the options
// dialog, the engine run_analysis payload, and persisted runs. Option KEYS
// match tests/fixtures/tier{1,2}/*/spec.json exactly - the engine rejects
// unknown keys (1001) and missing keys alike, so every key here ships a value.
import type { Measure } from './io/types.ts'

export type OptionKind = 'variable' | 'variable-list' | 'number' | 'enum' | 'boolean'

export interface SpecOption {
  key: string
  kind: OptionKind
  label: string
  hint?: string
  measures?: Measure[]
  required?: boolean
  default?: unknown
  values?: string[]
  enableWhen?: string
  min?: number
  max?: number
}

export interface AnalysisSchema {
  id: string
  title: string
  description?: string
  howTo?: string
  options: SpecOption[]
  missingDefault?: 'listwise' | 'pairwise'
}

const v = (key: string, label: string, measures: Measure[], hint?: string, extra: Partial<SpecOption> = {}): SpecOption =>
  ({ key, kind: 'variable', label, hint, measures, required: true, ...extra })
const vl = (key: string, label: string, measures: Measure[], hint?: string, extra: Partial<SpecOption> = {}): SpecOption =>
  ({ key, kind: 'variable-list', label, hint, measures, required: true, ...extra })
const n = (key: string, label: string, hint?: string, extra: Partial<SpecOption> = {}): SpecOption =>
  ({ key, kind: 'number', label, hint, required: true, ...extra })
const e = (key: string, label: string, values: string[], def: string, hint?: string): SpecOption =>
  ({ key, kind: 'enum', label, values, default: def, hint, required: true })

const SCALE: Measure[] = ['scale', 'ratio']
const ORD: Measure[] = ['scale', 'ratio', 'ordinal']
const GROUP: Measure[] = ['nominal', 'ordinal']
const ANY: Measure[] = ['nominal', 'ordinal', 'scale', 'ratio']
const ALT = ['two-sided', 'less', 'greater']

export const SCHEMAS: AnalysisSchema[] = [
  {
    id: 'factor_efa',
    title: 'Exploratory Factor Analysis (EFA / PCA)',
    description: 'Reduces a set of correlated items to a smaller number of latent factors, reporting sampling adequacy, eigenvalues, and rotated loadings.',
    howTo: 'Select three or more continuous (Scale) items to factor-analyze. Leave Number of factors at 0 to keep every eigenvalue above 1 (Kaiser), and pick Varimax rotation for a cleaner simple structure.',
    options: [
      vl('vars', 'Variables (choose three or more)', SCALE, 'Continuous items to factor-analyze (Scale, e.g., q1, q2, q3, q4)', { min: 3 }),
      n('nFactors', 'Number of factors', '0 keeps every factor with eigenvalue above 1 (Kaiser criterion)', { default: 0, min: 0 }),
      e('method', 'Extraction method', ['pca', 'paf'], 'pca', 'PCA analyzes total variance; principal axis factoring (PAF) analyzes shared variance only'),
      e('rotation', 'Rotation', ['varimax', 'none'], 'varimax', 'Varimax is an orthogonal rotation that sharpens which items load on which factor')
    ]
  },
  {
    id: 'reliability_cronbach',
    title: "Scale Reliability Analysis (Cronbach’s Alpha & McDonald’s Omega)",
    description: "Quantifies the internal consistency of a multi-item scale with Cronbach's alpha, its confidence interval, McDonald's omega, and item-total diagnostics.",
    howTo: 'Select two or more continuous (Scale) items that are meant to measure one construct (e.g., q1, q2, q3). Review the alpha-if-item-deleted column to spot an item that hurts the scale.',
    options: [
      vl('vars', 'Items (choose two or more)', SCALE, 'Continuous items forming the scale (Scale, e.g., q1, q2, q3)', { min: 2 })
    ]
  },
  {
    id: 'descriptives',
    title: 'Descriptive statistics',
    description: 'Summarizes the central tendency, dispersion, and distribution shapes of numeric variables.',
    howTo: 'Select continuous (Scale) or ordered (Ordinal) variables to generate mean, standard deviation, and range tables.',
    options: [vl('variables', 'Variables', ORD, 'Numeric/continuous or ordinal variables to summarize (e.g., salary, age)')]
  },
  {
    id: 'frequencies',
    title: 'Frequency tables',
    description: 'Calculates counts, percentages, and cumulative distributions for categorical and discrete variables.',
    howTo: 'Select categorical (Nominal) or discrete variables to view category distributions.',
    options: [vl('variables', 'Variables', ANY, 'Categorical or discrete variables to tabulate (e.g., department, gender)')]
  },
  {
    id: 'ttest_onesample',
    title: 'One-sample t-test',
    description: 'Tests whether the mean of a single continuous variable is statistically different from a known benchmark value.',
    howTo: '1. Put your continuous numeric measurement in Variable. 2. Enter your benchmark value in Test Value.',
    options: [
      v('dep', 'Variable', SCALE, 'Continuous numeric outcome (Scale, e.g., test score, salary)'),
      n('testValue', 'Test value', 'Hypothesized benchmark population mean', { default: 70 })
    ]
  },
  {
    id: 'ttest_independent',
    title: 'Independent-samples t-test',
    description: 'Compares the means of two unrelated groups to determine if there is a statistically significant difference.',
    howTo: '1. Put your continuous outcome in Dependent Variable(s). 2. Put your 2-group categorical variable in Grouping Variable.',
    options: [
      v('dep', 'Dependent variable(s)', SCALE, 'Continuous numeric outcome (Scale, e.g., salary, post_test)'),
      v('group', 'Grouping variable', GROUP, 'Categorical grouping variable with 2 groups (Nominal, e.g., treatment, gender)')
    ]
  },
  {
    id: 'ttest_paired',
    title: 'Paired-samples t-test',
    description: 'Compares two related or repeated continuous measurements from the same participants (e.g., pre-test vs. post-test).',
    howTo: '1. Put the first measurement in Variable A. 2. Put the second measurement in Variable B.',
    options: [
      v('a', 'Variable A', SCALE, 'First continuous measurement or Before condition (Scale, e.g., pre_test)'),
      v('b', 'Variable B', SCALE, 'Second continuous measurement or After condition (Scale, e.g., post_test)')
    ]
  },
  {
    id: 'anova_oneway',
    title: 'One-way ANOVA',
    description: 'Tests whether the means of a continuous variable differ significantly across three or more categorical groups.',
    howTo: '1. Dependent Variable: The continuous numeric outcome you are measuring (e.g., salary, performance). 2. Factor: The categorical variable that divides your data into groups (e.g., department, education).',
    options: [
      v('dep', 'Dependent variable', SCALE, 'Continuous numeric outcome to compare (Scale, e.g., salary, score)'),
      v('factor', 'Factor', GROUP, 'Categorical grouping variable with 3+ groups (Nominal, e.g., department, group)')
    ]
  },
  {
    id: 'welch_anova',
    title: 'Welch analysis of variance',
    description: 'Compares group means when group variances or sample sizes are unequal (robust alternative to standard ANOVA).',
    howTo: '1. Put your continuous outcome in Dependent Variable. 2. Put your categorical groups in Factor.',
    options: [
      v('dep', 'Dependent variable', SCALE, 'Continuous numeric outcome to compare (Scale, e.g., salary)'),
      v('factor', 'Factor', GROUP, 'Categorical grouping variable with 2+ groups (Nominal, e.g., department)'),
      e('useVar', 'Assume variances', ['unequal', 'equal'], 'unequal', 'Select unequal for Welch robust method')
    ]
  },
  {
    id: 'tukey_hsd',
    title: 'Tukey HSD post-hoc test',
    description: 'Performs all pairwise comparisons between group means while controlling the overall family-wise error rate.',
    howTo: 'Use following a significant ANOVA to identify exactly which specific pairs of groups differ.',
    options: [
      v('dep', 'Dependent variable', SCALE, 'Continuous numeric outcome (Scale, e.g., salary)'),
      v('factor', 'Factor', GROUP, 'Categorical grouping variable (Nominal, e.g., department)'),
      n('alpha', 'Family-wise error rate', 'Significance threshold (typically 0.05)', { default: 0.05 })
    ]
  },
  {
    id: 'factorial_anova_2way',
    title: 'Two-way factorial ANOVA',
    description: 'Evaluates the main effects of two independent categorical factors and their interaction on a continuous outcome.',
    howTo: '1. Put your continuous outcome in Dependent Variable. 2. Select exactly two categorical variables in Factors.',
    options: [
      v('dep', 'Dependent variable', SCALE, 'Continuous numeric outcome (Scale, e.g., performance)'),
      vl('factors', 'Factors (choose two)', GROUP, 'Select exactly two categorical grouping variables (e.g., department, gender)', { min: 2, max: 2 }),
      e('coding', 'Contrast coding', ['sum-to-zero', 'treatment'], 'sum-to-zero', 'Statistical coding scheme for factors')
    ]
  },
  {
    id: 'chisq_independence',
    title: 'Chi-square test of independence',
    description: 'Tests whether two categorical variables are related or independent in a contingency table.',
    howTo: '1. Put the first categorical variable in Row. 2. Put the second categorical variable in Column.',
    options: [
      v('row', 'Row variable', GROUP, 'First categorical classification (Nominal/Ordinal, e.g., department)'),
      v('col', 'Column variable', GROUP, 'Second categorical classification (Nominal/Ordinal, e.g., remote_work)')
    ]
  },
  {
    id: 'chisq_gof',
    title: 'Chi-square goodness of fit',
    description: 'Tests whether the observed proportions of categories in a single variable match an expected theoretical distribution.',
    howTo: 'Assign a categorical variable with observed frequencies to test against equal proportions.',
    options: [
      v('variable', 'Variable', GROUP, 'Categorical variable with category counts to evaluate'),
      e('expectedProportions', 'Expected proportions', ['equal'], 'equal', 'Hypothesized category distribution')
    ]
  },
  {
    id: 'fisher_exact_2x2',
    title: 'Fisher exact test (2 by 2)',
    description: 'Calculates the exact probability of association between two binary categorical variables (best for small cell counts).',
    howTo: '1. Select 2-category Row and Column variables. 2. Optionally select a Count variable if data is aggregated.',
    options: [
      v('row', 'Row variable', ANY, 'Binary row classification (2 categories)'),
      v('col', 'Column variable', ANY, 'Binary column classification (2 categories)'),
      v('count', 'Count variable', SCALE, 'Required: frequency per cell (aggregate rows; add a count = 1 column if each row is one case)'),
      e('alternative', 'Alternative hypothesis', ALT, 'two-sided', 'Directionality of the hypothesis test')
    ]
  },
  {
    id: 'mcnemar',
    title: 'McNemar test',
    description: 'Tests for changes in a binary categorical response before and after an intervention on the same subjects.',
    howTo: '1. Put pre-intervention binary status in Before. 2. Put post-intervention binary status in After.',
    options: [
      v('before', 'Before variable', ANY, 'Binary status before intervention (e.g., approved_pre)'),
      v('after', 'After variable', ANY, 'Binary status after intervention (e.g., approved_post)'),
      v('count', 'Count variable', SCALE, 'Required: frequency per cell (aggregate rows; add a count = 1 column if each row is one case)')
    ]
  },
  {
    id: 'correlation',
    title: 'Correlation matrix',
    description: 'Computes Pearson bivariate linear correlation coefficients (r) and significance levels between continuous variables.',
    howTo: 'Select two or more continuous (Scale) or Ordinal variables to correlate.',
    missingDefault: 'pairwise',
    options: [
      vl('variables', 'Variables (choose two or more)', ORD, 'Select 2+ continuous or ordinal variables (e.g., age, salary, satisfaction)', { min: 2 })
    ]
  },
  {
    id: 'kendall_tau',
    title: 'Kendall tau',
    description: 'Non-parametric measure of monotonic association and concordance between two ranked or continuous variables.',
    howTo: 'Select two continuous or ordinal variables to compute rank correlation.',
    options: [
      v('a', 'Variable A', ANY, 'First ranked or continuous variable'),
      v('b', 'Variable B', ANY, 'Second ranked or continuous variable'),
      e('alternative', 'Alternative hypothesis', ALT, 'two-sided'),
      e('method', 'P value method', ['auto', 'exact', 'asymptotic'], 'auto'),
      e('variant', 'Variant', ['a', 'b', 'c'], 'b')
    ]
  },
  {
    id: 'linear_regression',
    title: 'Linear regression',
    description: 'Models and quantifies the relationship between a continuous outcome and one or more independent predictor variables.',
    howTo: '1. Dependent Variable: The continuous numeric outcome you want to predict (e.g., salary). 2. Predictors: One or more explanatory variables (e.g., age, performance_rating).',
    options: [
      v('dep', 'Dependent variable', SCALE, 'Continuous outcome variable to predict (Scale, e.g., salary)'),
      vl('predictors', 'Predictors', ORD, 'One or more explanatory/independent variables (Scale or Ordinal, e.g., age, rating)', { min: 1 })
    ]
  },
  {
    id: 'logistic_regression',
    title: 'Logistic regression',
    description: 'Predicts the probability of a binary or categorical outcome (e.g., success/failure, yes/no) based on predictors.',
    howTo: '1. Dependent Variable: Binary categorical outcome (0/1 or Yes/No). 2. Predictors: Independent explanatory variables.',
    options: [
      v('dep', 'Dependent variable', ANY, 'Binary categorical outcome (e.g., promoted, retention)'),
      vl('predictors', 'Predictors', ANY, 'Predictor variables that explain the outcome probability', { min: 1 }),
      e('model', 'Link model', ['Logit', 'probit'], 'Logit')
    ]
  },
  {
    id: 'mannwhitney_u',
    title: 'Mann-Whitney U test',
    description: 'Non-parametric alternative to the independent t-test for comparing two groups when normality assumptions are violated.',
    howTo: '1. Dependent Variable: Ordinal or continuous outcome. 2. Grouping Variable: Categorical variable with 2 groups.',
    options: [
      v('dep', 'Dependent variable', ORD, 'Continuous or ordinal measurement (Scale/Ordinal, e.g., satisfaction)'),
      v('group', 'Grouping variable', GROUP, 'Categorical grouping variable with 2 groups (Nominal, e.g., treatment)')
    ]
  },
  {
    id: 'wilcoxon_signedrank',
    title: 'Paired-samples Wilcoxon signed-rank test',
    description: 'Non-parametric alternative to the paired t-test for comparing paired or repeated observations on skewed data.',
    howTo: '1. Put the first condition in Variable A. 2. Put the second condition in Variable B.',
    options: [
      v('a', 'Variable A', ORD, 'First paired measurement / Before (Scale/Ordinal, e.g., pre_test)'),
      v('b', 'Variable B', ORD, 'Second paired measurement / After (Scale/Ordinal, e.g., post_test)')
    ]
  },
  {
    id: 'wilcoxon_one_sample',
    title: 'One-sample Wilcoxon signed-rank test',
    description: 'Non-parametric test evaluating whether a single sample median differs significantly from a hypothesized median.',
    howTo: '1. Select your continuous or ordinal variable. 2. Set your hypothesized median benchmark.',
    options: [
      v('dep', 'Variable', ORD, 'Continuous or ordinal measurement (Scale/Ordinal)'),
      n('mu', 'Hypothesized median', 'Hypothesized population median benchmark', { default: 50 }),
      e('alternative', 'Alternative hypothesis', ALT, 'two-sided'),
      e('method', 'P value method', ['exact', 'approx', 'auto'], 'exact'),
      e('zeroMethod', 'Zero differences', ['wilcox', 'wilcox-pratt', 'zsplit'], 'wilcox')
    ]
  },
  {
    id: 'friedman',
    title: 'Friedman test',
    description: 'Non-parametric alternative to repeated-measures ANOVA for comparing three or more matched groups or conditions.',
    howTo: 'Select three or more continuous or ordinal variables representing matched conditions or timepoints.',
    options: [
      vl('conditions', 'Conditions (choose two or more)', ORD, 'Select 2+ continuous or ordinal repeated conditions', { min: 2 })
    ]
  },
  {
    id: 'kruskal_wallis',
    title: 'Kruskal-Wallis test',
    description: 'Non-parametric alternative to One-way ANOVA for comparing three or more independent groups with non-normal data.',
    howTo: '1. Dependent Variable: Continuous or ordinal outcome. 2. Factor: Categorical variable with 3+ groups.',
    options: [
      v('dep', 'Dependent variable', ORD, 'Continuous or ordinal measurement (Scale/Ordinal, e.g., rating)'),
      v('factor', 'Factor', GROUP, 'Categorical grouping variable with 3+ groups (Nominal, e.g., department)')
    ]
  },
  {
    id: 'binomial',
    title: 'Binomial test',
    description: 'Tests whether the observed proportion of a binary outcome matches an expected theoretical probability.',
    howTo: '1. Select variable containing successes. 2. Select variable or sample total for trials.',
    options: [
      v('variable', 'Successes variable', ANY, 'Variable indicating success events'),
      v('n', 'Trials variable', ANY, 'Variable indicating total trials/observations'),
      n('p0', 'Null probability', 'Hypothesized probability of success (0.0 to 1.0)', { default: 0.5 }),
      n('successLevel', 'Success level', 'Category value counted as a success', { default: 27 })
    ]
  }
]

export const schemaById = (id: string): AnalysisSchema | undefined => SCHEMAS.find((s) => s.id === id)

/** Missing values for a fresh dialog: defaults first, then the given initial. */
export function defaultValues(schema: AnalysisSchema, initial?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const o of schema.options) {
    if (initial && o.key in initial) out[o.key] = initial[o.key]
    else if (o.default !== undefined) out[o.key] = o.default
    else if (o.kind === 'variable-list') out[o.key] = []
    else if (o.kind === 'variable') out[o.key] = ''
    else if (o.kind === 'number') out[o.key] = null
    else if (o.kind === 'enum') out[o.key] = o.values?.[0] ?? ''
    else if (o.kind === 'boolean') out[o.key] = false
  }
  return out
}

/** Gating errors for the Run button; empty means the spec is submittable. */
export function validateValues(schema: AnalysisSchema, values: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const o of schema.options) {
    const val = values[o.key]
    if (o.enableWhen && !values[o.enableWhen]) continue
    if (o.kind === 'variable' && (typeof val !== 'string' || !val)) problems.push(`Choose ${o.label.toLowerCase()}`)
    else if (o.kind === 'variable-list') {
      const list = Array.isArray(val) ? val : []
      if (!list.length) problems.push(`Choose at least one variable for ${o.label.toLowerCase()}`)
      else if (o.min && list.length < o.min) problems.push(`${o.label} needs at least ${o.min} variables`)
      else if (o.max && list.length > o.max) problems.push(`${o.label} needs at most ${o.max} variables`)
    } else if (o.kind === 'number' && (typeof val !== 'number' || !Number.isFinite(val))) problems.push(`${o.label} needs a number`)
    else if (o.kind === 'enum' && !o.values?.includes(val as string)) problems.push(`${o.label} needs a choice`)
  }
  return problems
}

/** One-line spec summary for result descriptions and proposal cards. */
export function specSummary(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([k, val]) => `${k} = ${Array.isArray(val) ? val.join(', ') : String(val)}`)
    .join('; ')
}
