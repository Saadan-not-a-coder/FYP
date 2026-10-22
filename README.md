# Supply Chain Risk Management MVP

A full-stack predictive supply chain dashboard for calculating live order-level lead-time variance and risk-adjusted safety stock. 

## Tech Stack
* **Frontend:** React + Vite
* **Backend:** Python (FastAPI)
* **Database:** Supabase (PostgreSQL)

---

## 🚀 How to Run Locally

To run this project, you will need three separate terminal windows open at the same time.

### Prerequisites
Make sure you have Node.js and Python 3 installed on your machine.

### 1. Clone the Repository
Run this in your terminal to download the code and enter the folder:
`git clone https://github.com/Saadan-not-a-coder/FYP.git`
`cd FYP`

### 2. Start the Machine Learning API (Terminal 1)
This FastAPI microservice handles the risk mathematics and database communication. Open a terminal and run:
`pip install fastapi uvicorn supabase pydantic requests`
`python ml_service.py`
*Wait until it says "Uvicorn running on http://0.0.0.0:8000" and leave this terminal open.*

### 3. Start the React Frontend (Terminal 2)
This launches the Management by Exception dashboard. Open a second, new terminal window and run:
`npm install`
`npm run dev`
*Click the http://localhost:5173 link in the terminal to view the dashboard in your browser.*

### 4. Optional: Run the Batch Processor (Terminal 3)
If you need to process new raw orders and push fresh calculations to the Supabase cloud, open a third terminal while the FastAPI server (Terminal 1) is running:
`python run_all_orders.py`