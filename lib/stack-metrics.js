const logger = require('logger')
const Monitoring = require('@google-cloud/monitoring')

/**
 * Represents a custom metric variable in the application. Call to update the value.
 */
class StackMetric {
  constructor (stackMetrics, metricName) {
    this._stackMetrics = stackMetrics
    this._metricName = metricName
    this._count = 0
  }

  writeCount (delta) {
    return this.writeRate(delta)
  }

  writeRate (delta) {
    this._count += delta
    this._stackMetrics.writeMetric(this._metricName, this._count)
  }

  write (value) {
    this._stackMetrics.writeMetric(this._metricName, value)
  }
}

/**
 * Interface to Custom Metrics in Stackdriver Monitoring.
 */
class StackMetrics {
  /**
   * @param keyFilename Filename for service account key
   * @param projectId The project id
   * @param appName Application name (k8s namespace)
   * @param envName Environment name (dev, stage, production)
   * @param metricGroupName Grouping name of metrics handled by this StackMetrics instance. Could be either appName or
   * a name representing generic metrics for an app (version, health etc)
   * @param sendInterval Interval to send values to Stackdriver Monitoring API, milliseconds, default is 5000
   */
  constructor (keyFilename, projectId, appName, envName, metricGroupName, sendInterval) {
    this.projectId = projectId
    this.appName = appName
    this.envName = envName
    this.metricGroupName = metricGroupName
    this.prevSendTimestamp = Date.now()

    const monitoringV3 = Monitoring.v3({
      keyFilename: keyFilename
    })
    this.client = monitoringV3.metricServiceClient()

    setInterval(() => { this._sendValues() }, sendInterval)
    if (!sendInterval) {
      sendInterval = 5000
    }
    this.metricsMap = new Map()
  }

  /**
   * Create a custom metric request object, used in the Stackdriver Monitoring API
   * @param metricName Metric name, displayed
   * @param metricDescription Metric description. A one liner.
   * @param metricType StackMetrics.TYPE_...
   * @returns {StackMetric} Request object
   */
  createMetric (metricName, metricDescription, metricType) {
    const descriptor = {
      description: metricDescription,
      displayName: metricName,
      type: 'custom.googleapis.com/' + this.metricGroupName + '/' + metricName,
      metricKind: 'GAUGE',
      valueType: StackMetrics._getValueTypeForMetricType(metricType),
      labels: [
        {
          key: 'appName',
          valueType: 'STRING',
          description: 'Application name'
        },
        {
          key: 'envName',
          valueType: 'STRING',
          description: 'Environment (prod, stage, ...)'
        }
      ]
    }

    this.metricsMap.set(metricName, {
      name: metricName,
      valueType: StackMetrics._getValueTypeForMetricType(metricType),
      requestDescriptor: descriptor,
      responseDescriptor: undefined,
      rateInterval: StackMetrics._getRateIntervalForMetricType(metricType),
      value: 0
    })
    logger.info('Created metric', metricName)
    return new StackMetric(this, metricName)
  }

  /**
   * Write a custom metric value
   * @param metricName Name of metric
   * @param value Metric value
   */
  writeMetric (metricName, value) {
    StackMetrics.debug('writeMetric', metricName, value)
    const metric = this.metricsMap.get(metricName)
    if (metric.rateInterval) {
      // Metric is a Rate-type
      metric.value += value
    } else {
      // Metric is a value type
      metric.value = value
    }
  }

  async _sendValues () {
    StackMetrics.debug('_sendValues')
    // Send any pending createMetricDescriptors requests
    let responses
    try {
      responses = await Promise.all(
        Array.from(this.metricsMap.values())
          .filter(e => !e.responseDescriptor) // remove metrics we've already created
          .map(metric => {
            StackMetrics.debug('Sending createMetricDescriptor', metric.name)
            return this.client.createMetricDescriptor(this._createMetricsRequest(metric.requestDescriptor))
          }))
        .catch(err => { throw err })
    } catch (err) {
      logger.warn('createMetricDescriptor failed:', err)
      return
    }

    // Set responseDescriptor for each reply from createMetricDescriptor
    responses.forEach(response => {
      const descriptor = response[0]
      StackMetrics.debug('Sent createMetricDescriptor', descriptor.displayName)
      this.metricsMap.get(descriptor.displayName).responseDescriptor = descriptor
    })

    // Send pending metric values
    return this._sendTimeSeries()
  }

  _createMetricsRequest (descriptor) {
    return {
      name: this.client.projectPath(this.projectId),
      metricDescriptor: descriptor
    }
  }

  async _sendTimeSeries () {
    const now = Date.now()
    Array.from(this.metricsMap.values()) // Calculate rate from value (the sum) for rate types
      .filter(metric => metric.rateInterval)
      .forEach(metric => { metric.value /= (now - this.prevSendTimestamp) })

    this.prevSendTimestamp = Date.now()

    const timeSeriesData = Array.from(this.metricsMap.values())
      .map(metric => this._createTimeSeriesData(metric))

    const request = {
      name: this.client.projectPath(this.projectId),
      timeSeries: timeSeriesData
    }

    if (timeSeriesData.length > 0) {
      // Write time series data
      try {
        StackMetrics.debug('Sending time series data, number of timeSeries:', request.timeSeries.length)
        const results = await this.client.createTimeSeries(request)
        Array.from(this.metricsMap.values()).map(metric => {
          // Clear the rate values we've sent
          if (metric.rateInterval) metric.value = 0
          StackMetrics.debug('Sent time series data for metricName', metric.name)
        })
        return results
      } catch (err) {
        logger.warn('Error sending timeSeries:', err)
      }
    } else {
      StackMetrics.debug('_sendTimeSeries: Nothing to send')
    }
  }

  _createTimeSeriesData (metric) {
    return {
      metric: {
        type: metric.requestDescriptor.type,
        labels: {
          appName: this.appName,
          envName: this.envName
        }
      },
      resource: {
        type: 'global',
        labels: {
          project_id: this.projectId
        }
      },
      points: [StackMetrics._createDataPoint(metric.valueType, metric.value)]
    }
  }

  static _createDataPoint (valueType, sample) {
    switch (valueType) {
      case StackMetrics.VALUE_TYPE_INT64:
        return {
          interval: {
            endTime: {
              seconds: sample.endTime / 1000
            }
          },
          value: {
            int64Value: sample.value
          }
        }
      case StackMetrics.VALUE_TYPE_DOUBLE:
        return {
          interval: {
            endTime: {
              seconds: sample.endTime / 1000
            }
          },
          value: {
            doubleValue: sample.value
          }
        }
      case StackMetrics.VALUE_TYPE_BOOL:
        return {
          interval: {
            endTime: {
              seconds: sample.endTime / 1000
            }
          },
          value: {
            boolValue: sample.value
          }
        }
    }
  }

  static _getValueTypeForMetricType (metricType) {
    switch (metricType) {
      case StackMetrics.TYPE_INT64:
        return StackMetrics.VALUE_TYPE_INT64
      case StackMetrics.TYPE_BOOL:
        return StackMetrics.VALUE_TYPE_BOOL
      case StackMetrics.TYPE_DOUBLE:
        return StackMetrics.VALUE_TYPE_DOUBLE
      case StackMetrics.TYPE_RATE_PER_SECOND:
        return StackMetrics.VALUE_TYPE_DOUBLE
      case StackMetrics.TYPE_RATE_PER_MINUTE:
        return StackMetrics.VALUE_TYPE_DOUBLE
      case StackMetrics.TYPE_RATE_PER_HOUR:
        return StackMetrics.VALUE_TYPE_DOUBLE
      case StackMetrics.TYPE_RATE_PER_DAY:
        return StackMetrics.VALUE_TYPE_DOUBLE
      default:
        throw new Error('Unknown metricType', metricType)
    }
  }

  static _getRateIntervalForMetricType (metricType) {
    switch (metricType) {
      case StackMetrics.TYPE_RATE_PER_SECOND:
        return 1000
      case StackMetrics.TYPE_RATE_PER_MINUTE:
        return 1000 * 60
      case StackMetrics.TYPE_RATE_PER_HOUR:
        return 1000 * 3600
      case StackMetrics.TYPE_RATE_PER_DAY:
        return 1000 * 3600 * 24
      default:
        return undefined
    }
  }

  static debug () {
    if (StackMetric.debug) {
      arguments['0'] = 'STACK-METRICS '.concat(arguments['0'])
      return logger.debug.apply(logger, arguments)
    }
  }
}

StackMetric.debug = process.env.NODE_DEBUG && /\bstack-metrics\b/.test(process.env.NODE_DEBUG)

StackMetrics.VALUE_TYPE_INT64 = 'INT64'
StackMetrics.VALUE_TYPE_BOOL = 'BOOL'
StackMetrics.VALUE_TYPE_DOUBLE = 'DOUBLE'

StackMetrics.TYPE_INT64 = 'INT64'
StackMetrics.TYPE_BOOL = 'BOOL'
StackMetrics.TYPE_DOUBLE = 'DOUBLE'
StackMetrics.TYPE_RATE_PER_SECOND = 'RATE_PER_SECOND'
StackMetrics.TYPE_RATE_PER_MINUTE = 'RATE_PER_MINUTE'
StackMetrics.TYPE_RATE_PER_HOUR = 'RATE_PER_HOUR'
StackMetrics.TYPE_RATE_PER_DAY = 'RATE_PER_DAY'

module.exports = StackMetrics