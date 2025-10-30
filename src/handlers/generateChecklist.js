const puppeteer = require('puppeteer');
const templateLoader = require('../utils/templateLoader');
const logger = require('../utils/logger');
const config = require('../utils/config');
const { s3FSRFileOperations } = require('../helpers/s3Operations');
const { sleep, validateRequiredParams, isJSON } = require('../utils/constants');
const { generateDpgPDF } = require('../helpers/reportGenerationHelpers');
const { generateDcpsPDF } = require('../helpers/reportGenerationHelpers');
const { generateThermalPDF } = require('../helpers/reportGenerationHelpers');

module.exports.handler = async (event) => {
  const userAgent = event.headers?.['user-agent'] || '';
  const method = 'POST';
  const route = 'report.generateChecklist';

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    if (!body) {
      throw new Error('Invalid request body');
    }

    validateRequiredParams(body, ['type', 'call_no']);

    const type = String(body.type || '').toLowerCase();
    const params = body.params && (typeof body.params === 'string' ? (isJSON(body.params) ? JSON.parse(body.params) : {}) : body.params) || {};

    logger.logRequestStart(route, method, body, userAgent);

    const browser = await puppeteer.launch(config.getPuppeteerConfig());
    const page = await browser.newPage();

    let bufferContent = '';
    let bucketPath = '';
    let fileName = '';

    switch (type) {
      case 'dpg': {
        await page.setContent(templateLoader.getTemplate('dpg_checklist'));
        const customerSignature = body?.customer_signature && body.customer_signature.length > 1
          ? body.customer_signature : (params?.customerSignature || '');
        const engineerSignature = body?.engineer_signature && body.engineer_signature.length > 1
          ? body.engineer_signature : (params?.engineerSignature || '');

        try {
          bufferContent = await generateDpgPDF(
            page,
            {
              ...body,
              engineerSignature,
              customerSignature,
              ...(params?.form_data && Array.isArray(params.form_data) && params.form_data[0] ? params.form_data[0] : {}),
              battery_data: params?.battery_data
            }
          );
        } catch (err) {
          if (String(err.message).includes('Printing failed')) {
            await sleep(config.app.fsrReattemptTimeout);
            bufferContent = await generateDpgPDF(
              page,
              {
                ...body,
                engineerSignature,
                customerSignature,
                ...(params?.form_data && Array.isArray(params.form_data) && params.form_data[0] ? params.form_data[0] : {}),
                battery_data: params?.battery_data
              }
            );
          } else {
            throw err;
          }
        }
        bucketPath = `pm_checklist/${new Date().getFullYear()}`;
        fileName = `${body.call_no.toLowerCase()}_pm_checklist.pdf`;
        break;
      }

      case 'air': {
        await page.setContent(templateLoader.getTemplate('thermal_checklist'));
        const customerSignature = body?.customer_signature && body.customer_signature.length > 1
          ? body.customer_signature : (params?.customerSignature || '');
        const engineerSignature = body?.engineer_signature && body.engineer_signature.length > 1
          ? body.engineer_signature : (params?.engineerSignature || '');
        try {
          bufferContent = await generateThermalPDF(
            page,
            {
              ...body,
              ...(params || {}),
              engineerSignature,
              customerSignature,
              ...(params?.form_data && Array.isArray(params.form_data) && params.form_data[0] ? params.form_data[0] : {}),
              battery_data: params?.battery_data
            }
          );
        } catch (err) {
          if (String(err.message).includes('Printing failed')) {
            await sleep(config.app.fsrReattemptTimeout);
            bufferContent = await generateThermalPDF(
              page,
              {
                ...body,
                engineerSignature,
                customerSignature,
                ...(params?.form_data && Array.isArray(params.form_data) && params.form_data[0] ? params.form_data[0] : {}),
                battery_data: params?.battery_data
              }
            );
          } else {
            throw err;
          }
        }
        bucketPath = `pm_checklist/${new Date().getFullYear()}`;
        fileName = `${body.call_no.toLowerCase()}_pm_checklist.pdf`;
        break;
      }

      case 'dcps': {
        await page.setContent(templateLoader.getTemplate('dcps_checklist'));
        const customerSignature = body?.customer_signature && body.customer_signature.length > 1
          ? body.customer_signature : (params?.customerSignature || '');
        const engineerSignature = body?.engineer_signature && body.engineer_signature.length > 1
          ? body.engineer_signature : (params?.engineerSignature || '');
        try {
          bufferContent = await generateDcpsPDF(
            page,
            {
              ...body,
              ...(params || {}),
              engineerSignature,
              customerSignature,
              ...(params?.form_data && Array.isArray(params.form_data) && params.form_data[0] ? params.form_data[0] : {}),
              battery_data: params?.battery_data
            }
          );
        } catch (err) {
          if (String(err.message).includes('Printing failed')) {
            await sleep(config.app.fsrReattemptTimeout);
            bufferContent = await generateDcpsPDF(
              page,
              {
                ...body,
                engineerSignature,
                customerSignature,
                ...(params?.form_data && Array.isArray(params.form_data) && params.form_data[0] ? params.form_data[0] : {}),
                battery_data: params?.battery_data
              }
            );
          } else {
            throw err;
          }
        }
        bucketPath = `pm_checklist/${new Date().getFullYear()}`;
        fileName = `${body.call_no.toLowerCase()}_pm_checklist.pdf`;
        break;
      }

      default:
        throw new Error('The required "type" param provided does not match any type');
    }

    await browser.close();

    if (!bufferContent || !bufferContent.length) {
      throw new Error('PDF content is not generated or undefind');
    }

    let etag = '';
    if (config.isS3Configured()) {
      await s3FSRFileOperations('post', fileName, bufferContent, '', bucketPath, true);
      etag = await s3FSRFileOperations('location', fileName, '', '', bucketPath, true);
    }

    const response = { success: true, etag, fileName, path: bucketPath };
    logger.logResponse(route, response, userAgent);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(response)
    };

  } catch (error) {
    const errorResponse = { success: false, error: error.message };
    logger.logResponse(route, errorResponse, userAgent);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(errorResponse)
    };
  }
};


