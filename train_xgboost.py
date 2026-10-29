import pandas as pd
import numpy as np
import xgboost as xgb
import joblib

print("Generating synthetic SME supply chain data...")
np.random.seed(42)
n_samples = 1000

# Simulate Base Features
vendor_ids = np.random.choice([1, 2], size=n_samples)
quantity = np.random.randint(50, 500, size=n_samples)
unit_price = np.random.uniform(10.0, 150.0, size=n_samples)
promised_lead_time = np.random.randint(5, 15, size=n_samples)
n_history = np.random.randint(5, 50, size=n_samples)

# Simulate Vendor-specific historical stats (Vendor 2 is highly volatile)
mu_L = np.where(vendor_ids == 2, np.random.normal(12, 1, n_samples), np.random.normal(7, 1, n_samples))
sigma_L = np.where(vendor_ids == 2, np.random.normal(2.5, 0.3, n_samples), np.random.normal(1.2, 0.2, n_samples))

# Stage 1: Generate Lateness Target (Vendor 2 and large orders have higher delay risk)
prob_late = np.where(vendor_ids == 2, 0.75, 0.15) + (quantity / 2500)
is_late = (np.random.rand(n_samples) < prob_late).astype(int)

# Stage 2: Generate Delay Magnitude (If late)
delay_days = np.where(is_late == 1, 
                      np.where(vendor_ids == 2, np.random.normal(5.0, 1.5, n_samples), np.random.normal(1.5, 0.5, n_samples)), 
                      0)
delay_days = np.maximum(0, delay_days)

df = pd.DataFrame({
    'quantity': quantity,
    'unit_price': unit_price,
    'promised_lead_time': promised_lead_time,
    'n_history': n_history,
    'mu_L': mu_L,
    'sigma_L': sigma_L,
    'is_late': is_late,
    'delay_days': delay_days
})

# Define exact features matching AHZAM.md Section 5.2
feature_cols = ['quantity', 'unit_price', 'promised_lead_time', 'n_history', 'mu_L', 'sigma_L']
X = df[feature_cols]
y_classify = df['is_late']

# Filter data for Stage 2 (Only train regressor on actually late orders)
X_regress = df[df['is_late'] == 1][feature_cols]
y_regress = df[df['is_late'] == 1]['delay_days']

print("Training Stage 1: XGBoost Classifier (Probability of Delay)...")
classifier = xgb.XGBClassifier(eval_metric='logloss', max_depth=4, learning_rate=0.1)
classifier.fit(X, y_classify)

print("Training Stage 2: XGBoost Regressor (Magnitude of Delay)...")
regressor = xgb.XGBRegressor(objective='reg:squarederror', max_depth=4, learning_rate=0.1)
regressor.fit(X_regress, y_regress)

# Save the models to disk
joblib.dump(classifier, 'delay_classifier.pkl')
joblib.dump(regressor, 'delay_regressor.pkl')

print("Models successfully trained with all 6 features and saved!")
