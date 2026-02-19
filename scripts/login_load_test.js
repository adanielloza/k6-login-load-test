import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Rate } from "k6/metrics";

const BASE_URL = "https://fakestoreapi.com";
const LOGIN_PATH = "/auth/login";
const TARGET_TPS = 20;
const SLA_MS = 1500;

export const functional_errors = new Rate("functional_errors"); // status/token inválido
export const slow_requests = new Rate("slow_requests"); // duration > SLA

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const header = lines.shift().split(",").map((h) => h.trim());
  return lines.map((line) => {
    const cols = line.split(",");
    const row = {};
    header.forEach((h, i) => (row[h] = (cols[i] || "").trim()));
    return row;
  });
}

const users = new SharedArray("users", () => parseCSV(open("../data/users.csv")));

export const options = {
  scenarios: {
    login_20tps: {
      executor: "constant-arrival-rate",
      rate: TARGET_TPS,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.03"], // fallos técnicos (timeouts/network)
    functional_errors: ["rate<0.03"],
    slow_requests: ["rate<0.03"],
    http_reqs: [`rate>=${TARGET_TPS}`],
    http_req_duration: [`max<${SLA_MS}`], // opcional: estricto, puede fallar por outliers
  },
};

export default function () {
  const u = users[__ITER % users.length]; // rotación desde CSV

  const payload = JSON.stringify({ username: u.user, password: u.passwd });
  const params = {
    headers: { "Content-Type": "application/json" },
    timeout: "60s",
    tags: { name: "POST /auth/login" },
  };

  const res = http.post(`${BASE_URL}${LOGIN_PATH}`, payload, params);

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "token presente": (r) => {
      try {
        const body = r.json();
        return body && typeof body.token === "string" && body.token.length > 0;
      } catch (_) {
        return false;
      }
    },
  });

  functional_errors.add(!ok);
  slow_requests.add(res.timings.duration > SLA_MS);

  sleep(0.01); // no controla TPS; el executor lo controla
}