import pymysql
import boto3
import os
import ssl
import json
import time
import requests

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

def lambda_handler(event, context):
    conn = connect_with_retry()
    cursor = conn.cursor()
    cloudwatch = boto3.client('cloudwatch')
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

    # Push to CloudWatch in batches of 20
    for i in range(0, len(metric_data), 20):
        cloudwatch.put_metric_data(
            Namespace='RailwayApp/Metrics',
            MetricData=metric_data[i:i+20]
        )

    cursor.close()
    conn.close()

    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': f"✅ Sent {len(metric_data)} metrics for the last 24 hours",
            'metrics': metric_data
        })
    }
