/**
 * Sample datasets for ARAStat: designed to showcase data health checks,
 * missing-value handling, skewness & outlier detection, statistical tests,
 * and APA 7th result reporting.
 */

export interface SampleDatasetDef {
  id: string;
  name: string;
  filename: string;
  category: string;
  badge: string;
  badgeClass: 'badge-missing' | 'badge-skewed' | 'badge-ordinal' | 'badge-clean';
  shortDesc: string;
  issues: string[];
  bestFor: string;
  rows: number;
  cols: number;
  csv: string;
}

export const SAMPLE_DATASETS: SampleDatasetDef[] = [
  {
    id: 'customer_churn',
    name: 'Customer Churn & Survey',
    filename: 'Customer_Churn_Survey.sav',
    category: 'Missing Values & Imputation',
    badge: 'Missing Values (18%)',
    badgeClass: 'badge-missing',
    shortDesc: 'Customer subscription metrics with realistic missing cells across income and satisfaction.',
    issues: [
      'Missing values in income (18%), satisfaction (14%), and monthly_spend (7%)',
      'Mixed measurement types (scale, nominal, ordinal)',
      'Subgroup imbalance between churned and active users'
    ],
    bestFor: 'AI Missing Value Advisor, Listwise/Pairwise comparison, Mean/Median Imputation, Logistic Regression, Chi-Square',
    rows: 25,
    cols: 7,
    csv: `customer_id,plan_type,monthly_spend,satisfaction,annual_income,support_calls,churned
C101,Standard,45.50,4,52000,1,No
C102,Premium,89.00,5,88000,0,No
C103,Basic,29.90,2,34000,4,Yes
C104,Premium,95.50,4,92000,2,No
C105,Standard,49.00,,48000,3,Yes
C106,Basic,25.00,1,,6,Yes
C107,Standard,55.00,3,56000,2,No
C108,Premium,110.00,5,115000,1,No
C109,Basic,32.00,2,31000,5,Yes
C110,Standard,,4,59000,1,No
C111,Premium,85.00,3,,3,No
C112,Standard,48.00,3,51000,2,No
C113,Basic,27.50,1,28000,7,Yes
C114,Premium,105.00,5,120000,0,No
C115,Standard,52.00,,54000,2,No
C116,Basic,30.00,2,36000,4,Yes
C117,Premium,,4,98000,1,No
C118,Standard,58.00,4,62000,1,No
C119,Basic,24.00,1,,5,Yes
C120,Premium,92.00,5,91000,1,No
C121,Standard,47.00,2,47000,3,Yes
C122,Premium,115.00,,130000,0,No
C123,Basic,31.00,3,33000,4,No
C124,Standard,50.00,4,58000,2,No
C125,Premium,99.00,4,102000,1,No`
  },
  {
    id: 'clinical_trial',
    name: 'Clinical Trial & Biomarkers',
    filename: 'Clinical_Trial_Biomarkers.sav',
    category: 'Biostatistics & Skewness',
    badge: 'Right-Skewed & Outliers',
    badgeClass: 'badge-skewed',
    shortDesc: 'Patient recovery study featuring heavily skewed recovery days and extreme medical cost outliers.',
    issues: [
      'Heavily right-skewed recovery days (skewness > 2.2, Shapiro-Wilk p < .01)',
      'Severe cost outliers ($28,500 vs median $2,400)',
      'Unequal group variances across dosage tiers'
    ],
    bestFor: 'Normality evaluation, Log Transformation, Mann-Whitney U, Kruskal-Wallis, Welch ANOVA',
    rows: 24,
    cols: 7,
    csv: `patient_id,treatment_group,baseline_bp,followup_bp,recovery_days,medical_cost,adverse_event
PT-01,Control,142,139,14,1850,No
PT-02,Control,138,136,12,1600,No
PT-03,Control,150,148,19,2400,No
PT-04,Control,145,142,16,2100,No
PT-05,Control,155,151,24,3200,Yes
PT-06,Control,140,138,11,1500,No
PT-07,Control,162,158,45,18200,Yes
PT-08,Control,148,144,15,2050,No
PT-09,LowDose,144,130,8,1950,No
PT-10,LowDose,139,126,7,1750,No
PT-11,LowDose,152,134,10,2300,No
PT-12,LowDose,148,131,9,2100,No
PT-13,LowDose,156,138,14,2900,Yes
PT-14,LowDose,141,128,6,1650,No
PT-15,LowDose,160,142,11,2600,No
PT-16,LowDose,146,129,8,1900,No
PT-17,HighDose,145,118,4,2200,No
PT-18,HighDose,140,115,5,1900,No
PT-19,HighDose,155,122,6,2700,No
PT-20,HighDose,150,120,4,2400,No
PT-21,HighDose,165,128,8,3400,Yes
PT-22,HighDose,142,116,5,2000,No
PT-23,HighDose,170,135,62,28500,Yes
PT-24,HighDose,148,119,4,2300,No`
  },
  {
    id: 'student_psych',
    name: 'Student Psychology & Exam',
    filename: 'Student_Psychology_Exam.sav',
    category: 'Psychology & Likert',
    badge: 'Ordinal Scales & Paired',
    badgeClass: 'badge-ordinal',
    shortDesc: 'Academic stress and exam performance dataset with 1-5 Likert items and repeated-measures tests.',
    issues: [
      'Ordinal 5-point Likert ratings (stress, motivation)',
      'Pre-post exam scores suitable for paired comparisons',
      'Bimodal stress level distribution'
    ],
    bestFor: 'Spearman & Kendall Tau Correlation, Paired t-test, Wilcoxon Signed-Rank, Chi-Square Test',
    rows: 22,
    cols: 7,
    csv: `student_id,study_hours,stress_level,motivation_score,midterm_score,final_score,passed
S201,12.5,4,3,68,74,Yes
S202,18.0,2,5,82,88,Yes
S203,6.5,5,2,54,58,No
S204,15.0,3,4,76,82,Yes
S205,8.0,5,2,60,62,No
S206,22.0,1,5,91,95,Yes
S207,14.5,3,4,72,78,Yes
S208,5.0,5,1,48,51,No
S209,16.5,2,4,79,85,Yes
S210,10.0,4,3,65,70,Yes
S211,7.5,5,2,58,59,No
S212,20.0,2,5,88,92,Yes
S213,13.0,3,3,70,75,Yes
S214,9.5,4,3,63,66,Yes
S215,4.5,5,1,45,46,No
S216,17.5,2,4,84,89,Yes
S217,11.0,4,3,67,71,Yes
S218,19.5,1,5,90,94,Yes
S219,8.5,4,2,59,64,No
S220,15.5,3,4,75,80,Yes
S221,6.0,5,2,52,55,No
S222,21.0,1,5,93,96,Yes`
  },
  {
    id: 'employee_clean',
    name: 'Employee Compensation',
    filename: 'Employee_Compensation_Clean.sav',
    category: 'Business & Regression',
    badge: 'Clean Baseline',
    badgeClass: 'badge-clean',
    shortDesc: 'Balanced, complete workforce dataset with no missing values or extreme anomalies.',
    issues: [
      'Complete cases with zero missing values',
      'Normal distribution on salary and performance rating',
      'Well-balanced factor levels across departments'
    ],
    bestFor: 'Multiple Linear Regression, Two-Way ANOVA, Descriptives, Pearson Correlation, APA Tables',
    rows: 16,
    cols: 7,
    csv: `emp_name,department,salary,performance_rating,age,experience_years,remote_work
Alice,Engineering,92000,4.8,32,7,Yes
Bob,Engineering,88000,4.2,29,5,Yes
Charlie,Marketing,71000,3.9,28,4,No
Diana,Marketing,76000,4.5,35,8,Yes
Evan,Sales,68000,3.6,26,3,No
Fiona,Sales,81000,4.7,34,7,No
George,Engineering,99000,4.9,41,12,Yes
Hannah,Marketing,69000,3.8,27,3,No
Ian,Sales,74000,4.1,31,6,Yes
Julia,Engineering,89000,4.3,30,6,No
Kevin,Sales,65000,3.4,25,2,No
Laura,Marketing,78000,4.6,36,9,Yes
Marcus,Engineering,95000,4.7,38,10,Yes
Nora,Sales,72000,4.0,29,5,No
Oscar,Marketing,74000,4.2,33,6,Yes
Patricia,Engineering,91000,4.4,31,7,No`
  }
];

export function getSampleDataset(id: string): SampleDatasetDef {
  return SAMPLE_DATASETS.find((s) => s.id === id) ?? SAMPLE_DATASETS[0];
}
