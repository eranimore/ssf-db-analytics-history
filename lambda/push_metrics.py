import pymysql
import boto3
import os
import ssl
import json
import time
import requests

METRICS_INGEST_URL = "https://ssf-db-analytics-history.eran-more.workers.dev/api/metrics/ingest"

# Flip either of these off to disable that push without touching the rest of the script.
PUSH_TO_CLOUDWATCH = True
PUSH_TO_SSF_ANALYTICS = True

def connect_with_retry(retries=3, delay=10):
    for attempt in range(1, retries + 1):
        try:
            return pymysql.connect(
                host='crossover.proxy.rlwy.net',
                port=12915,
                user=os.environ['DB_USER'],
                password=os.environ['DB_PASSWORD'],
                database=os.environ['DB_NAME'],
                connect_timeout=10,
                ssl={'cert_reqs': ssl.CERT_NONE}
            )
        except Exception as e:
            print(f"⚠️ DB connection attempt {attempt} failed: {e}")
            if attempt < retries:
                time.sleep(delay)
            else:
                raise RuntimeError("❌ Failed to connect to the database after multiple attempts.") from e


def to_metrics_rows(metric_data, recorded_at):
    """Flatten CloudWatch-shaped metric_data entries into METRICS_HISTORY rows."""
    rows = []
    for item in metric_data:
        pool_id = None
        extra_dimension_name = None
        extra_dimension_value = None
        for dim in item['Dimensions']:
            if dim['Name'] == 'POOL_ID':
                pool_id = dim['Value']
            else:
                extra_dimension_name = dim['Name']
                extra_dimension_value = dim['Value']
        rows.append({
            'metric_name': item['MetricName'],
            'pool_id': pool_id,
            'dimension_name': extra_dimension_name,
            'dimension_value': extra_dimension_value,
            'value': item['Value'],
            'recorded_at': recorded_at,
        })
    return rows


def lambda_handler(event, context):
    conn = connect_with_retry()
    cursor = conn.cursor()
    cloudwatch = boto3.client('cloudwatch') if PUSH_TO_CLOUDWATCH else None
    metric_data = []

    # 1. Sessions — last 24 hours
    cursor.execute("""
        SELECT POOL_ID, COUNT(*)
        FROM SESSIONS_SCHEDULE
        WHERE SESSION_DATETIME >= NOW() - INTERVAL 1 DAY
        GROUP BY POOL_ID
    """)
    for pool_id, count in cursor.fetchall():
        metric_data.append({
            'MetricName': 'SessionCount',
            'Dimensions': [{'Name': 'POOL_ID', 'Value': str(pool_id)}],
            'Value': count,
            'Unit': 'Count'
        })

    # 2. Sent Notifications — last 24 hours
    cursor.execute("""
        SELECT POOL_ID, CHANNEL, COUNT(*)
        FROM SENT_NOTIFICATIONS
        WHERE NOTIFICATION_TIME >= NOW() - INTERVAL 1 DAY
        GROUP BY POOL_ID, CHANNEL
    """)
    for pool_id, channel, count in cursor.fetchall():
        metric_data.append({
            'MetricName': 'SentNotifications',
            'Dimensions': [
                {'Name': 'POOL_ID', 'Value': str(pool_id)},
                {'Name': 'CHANNEL', 'Value': str(channel)}
            ],
            'Value': count,
            'Unit': 'Count'
        })

    # 3. Email Verifications — last 24 hours
    cursor.execute("""
        SELECT POOL_ID, COUNT(*)
        FROM EMAIL_VERIFICATIONS
        WHERE CREATED_AT >= NOW() - INTERVAL 1 DAY
        GROUP BY POOL_ID
    """)
    for pool_id, count in cursor.fetchall():
        metric_data.append({
            'MetricName': 'EmailVerifications',
            'Dimensions': [{'Name': 'POOL_ID', 'Value': str(pool_id)}],
            'Value': count,
            'Unit': 'Count'
        })

    # 4. User Preferences — last 24 hours
    cursor.execute("""
        SELECT POOL_ID, IS_ACTIVE, COUNT(*)
        FROM USERS_PREFERENCES
        WHERE UPDATED_AT >= NOW() - INTERVAL 1 DAY
           OR CREATED_AT >= NOW() - INTERVAL 1 DAY
        GROUP BY POOL_ID, IS_ACTIVE
    """)
    for pool_id, is_active, count in cursor.fetchall():
        metric_data.append({
            'MetricName': 'UserPreferences',
            'Dimensions': [
                {'Name': 'POOL_ID', 'Value': str(pool_id)},
                {'Name': 'IS_ACTIVE', 'Value': str(is_active)}
            ],
            'Value': count,
            'Unit': 'Count'
        })

    # 5. Total Unique Users by POOL_ID
    cursor.execute("""
        SELECT POOL_ID, COUNT(DISTINCT CHANNEL_USER_IDENTITY)
        FROM USERS_PREFERENCES
        GROUP BY POOL_ID
    """)
    for pool_id, count in cursor.fetchall():
        metric_data.append({
            'MetricName': 'TotalUniqueUsers',
            'Dimensions': [{'Name': 'POOL_ID', 'Value': str(pool_id)}],
            'Value': count,
            'Unit': 'Count'
        })

    # 6. Clicks statistics
    # Call get with url https://ssf-url-tracker-1.eran-more.workers.dev/ssf_stats24h
    # Response is like: [{"pool_id":"il/srf-park-tlv","count":2},{"pool_id":"us/skudinsurf-newjersey","count":2}]
    # Extract by pool and insert
    response = requests.get('https://ssf-url-tracker-1.eran-more.workers.dev/ssf_stats24h')
    if response.status_code == 200:
        for item in response.json():
            pool_id = item['pool_id']
            count = item['count']
            metric_data.append({
                'MetricName': 'RedirectedClick',
                'Dimensions': [{'Name': 'POOL_ID', 'Value': pool_id}],
                'Value': count,
                'Unit': 'Count'
            })

    # Push to CloudWatch in batches of 20 (unchanged — a failure here still
    # raises and fails the run, same as before these two paths were split out).
    cloudwatch_status = "skipped"
    if PUSH_TO_CLOUDWATCH:
        for i in range(0, len(metric_data), 20):
            cloudwatch.put_metric_data(
                Namespace='RailwayApp/Metrics',
                MetricData=metric_data[i:i+20]
            )
        cloudwatch_status = "ok"
        print(f"✅ CloudWatch: pushed {len(metric_data)} metrics")

    # Also push to the new D1-backed metrics dashboard, tagged with a single
    # shared timestamp for this run. Wrapped in try/except so a hiccup in the
    # new system (still being validated) can't break the CloudWatch path above.
    ssf_analytics_status = "skipped"
    if PUSH_TO_SSF_ANALYTICS:
        recorded_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        rows = to_metrics_rows(metric_data, recorded_at)
        try:
            ingest_response = requests.post(
                METRICS_INGEST_URL,
                headers={
                    'Content-Type': 'application/json',
                    'X-Metrics-Key': os.environ['METRICS_INGEST_KEY'],
                },
                json=rows,
                timeout=15,
            )
            ingest_response.raise_for_status()
            ssf_analytics_status = "ok"
            print(f"✅ ssf-analytics: pushed {len(rows)} metrics")
        except Exception as e:
            ssf_analytics_status = "FAILED"
            print(f"⚠️ ssf-analytics: push failed (CloudWatch unaffected): {e}")

    cursor.close()
    conn.close()

    return {
        'statusCode': 200,
        'body': json.dumps({
            'cloudwatch_status': cloudwatch_status,
            'ssf_analytics_status': ssf_analytics_status,
            'metrics_count': len(metric_data),
            'metrics': metric_data
        })
    }
