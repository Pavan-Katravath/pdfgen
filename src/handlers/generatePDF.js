const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');
const templateLoader = require('../utils/templateLoader');
const logger = require('../utils/logger');
const config = require('../utils/config');
const { 
  generateDPGReport, 
  generateThermalOrPowerReport, 
  generateDCPSReport,
  generatePartReturnedAndConsumedTable,
  generateSafetyTable
} = require('../helpers/reportGenerationHelpers');
const { s3FSRFileOperations } = require('../helpers/s3Operations');
const { sleep, validateRequiredParams } = require('../utils/constants');

// Use regular puppeteer for local development
let puppeteerInstance = puppeteer;
const isLocalEnvironment = process.env.NODE_ENV === 'local' || 
                          process.env.STAGE === 'dev' || 
                          process.env.STAGE === 'local' ||
                          !process.env.AWS_LAMBDA_FUNCTION_NAME;

if (isLocalEnvironment) {
  try {
    puppeteerInstance = require('puppeteer');
  } catch (e) {
    console.warn('Regular puppeteer not available, using puppeteer-core');
  }
}

module.exports.handler = async (event) => {
  const userAgent = event.headers?.['user-agent'] || '';
  logger.logRequestStart('notification.report', 'POST', event.body, userAgent);
  
  try {
    const param = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const paramObj = param.params ? JSON.parse(param.params) : undefined;
    
    // Validate required parameters
    validateRequiredParams(param, ['call_no', 'product_group']);
    
    const { issuedEls, returnedEls } = generatePartReturnedAndConsumedTable(param, 3, false);
    
    const finalObject = {
      param,
      paramObj,
      tableHTML: param.product_group.toLowerCase() !== 'dcps' ? generateSafetyTable(paramObj?.formdata) : "",
      returnedEls,
      issuedEls,
    };

    logger.logPDFGeneration(param.product_group, param.call_no, 'STARTED');

    // Configure Puppeteer for local vs Lambda environment
    let browserConfig;
    console.log('Environment check:', { NODE_ENV: process.env.NODE_ENV, STAGE: process.env.STAGE });
    
    // Check if we're running locally (not in AWS Lambda)
    const isLocalEnvironment = process.env.NODE_ENV === 'local' || 
                              process.env.STAGE === 'dev' || 
                              process.env.STAGE === 'local' ||
                              !process.env.AWS_LAMBDA_FUNCTION_NAME;
    
    if (isLocalEnvironment) {
      // Local development - use system Chrome or install puppeteer
      browserConfig = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ],
        ignoreHTTPSErrors: true,
      };
      
      // Try to find Chrome executable
      const possiblePaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/opt/homebrew/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/opt/homebrew/Caskroom/chromium/latest/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        '/opt/homebrew/Caskroom/chromium/latest/chromium.wrapper.sh'
      ];
      
      let chromeFound = false;
      for (const path of possiblePaths) {
        try {
          const fs = require('fs');
          if (fs.existsSync(path)) {
            browserConfig.executablePath = path;
            chromeFound = true;
            console.log(`Using Chrome executable: ${path}`);
            break;
          }
        } catch (e) {
          // Continue to next path
        }
      }
      
      if (!chromeFound) {
        console.warn('No Chrome executable found, trying without executablePath');
        // If no Chrome found and we're using puppeteer-core, try to fallback to regular puppeteer
        if (puppeteerInstance === puppeteer) {
          try {
            puppeteerInstance = require('puppeteer');
            console.log('Falling back to regular puppeteer package');
          } catch (e) {
            console.error('Both puppeteer-core and puppeteer failed:', e.message);
          }
        }
      }
    } else {
      // AWS Lambda environment
      browserConfig = {
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
      };
    }

    console.log('Using puppeteer instance:', puppeteerInstance === puppeteer ? 'puppeteer-core' : 'puppeteer');
    console.log('Browser config:', JSON.stringify(browserConfig, null, 2));
    
    let browser;
    try {
      browser = await puppeteerInstance.launch(browserConfig);
    } catch (launchError) {
      console.error('Browser launch failed:', launchError.message);
      
      // If puppeteer-core failed and we haven't tried regular puppeteer yet, try it
      if (puppeteerInstance === puppeteer && !browserConfig.executablePath) {
        try {
          console.log('Retrying with regular puppeteer package...');
          puppeteerInstance = require('puppeteer');
          browser = await puppeteerInstance.launch({
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--no-first-run',
              '--no-zygote',
              '--disable-gpu',
              '--disable-web-security',
              '--disable-features=VizDisplayCompositor'
            ],
            ignoreHTTPSErrors: true,
          });
          console.log('Successfully launched browser with regular puppeteer');
        } catch (fallbackError) {
          console.error('Fallback to regular puppeteer also failed:', fallbackError.message);
          throw new Error(`Failed to launch browser: ${launchError.message}. Fallback also failed: ${fallbackError.message}`);
        }
      } else {
        throw launchError;
      }
    }

    const page = await browser.newPage();
    let bufferContent = '';

    switch (param.product_group.toLowerCase()) {
      case 'dpg':
        await page.setContent(templateLoader.getTemplate('dpg'));
        try {
          bufferContent = await generateDPGReport(page, finalObject);
        } catch (err) {
          logger.error('DPG PDF generation failed:', err.message);
          if (err.message === "Protocol error (Page.printToPDF): Printing failed") {
            const reAttemptTimeout = config.app.fsrReattemptTimeout;
            logger.info(`Re-attempting DPG PDF generation after ${reAttemptTimeout}ms`);
            await sleep(reAttemptTimeout);
            bufferContent = await generateDPGReport(page, finalObject);
          } else {
            throw err;
          }
        }
        break;

      case 'air':
      case 'power':
      case 'thermal':
        await page.setContent(templateLoader.getTemplate('thermal'));
        try {
          bufferContent = await generateThermalOrPowerReport(page, finalObject);
        } catch (err) {
          logger.error('Thermal/Power PDF generation failed:', err.message);
          if (err.message === "Protocol error (Page.printToPDF): Printing failed") {
            const reAttemptTimeout = config.app.fsrReattemptTimeout;
            logger.info(`Re-attempting Thermal/Power PDF generation after ${reAttemptTimeout}ms`);
            await sleep(reAttemptTimeout);
            bufferContent = await generateThermalOrPowerReport(page, finalObject);
          } else {
            throw err;
          }
        }
        break;

      case 'dcps':
        await page.setContent(templateLoader.getTemplate('dcps'));
        try {
          bufferContent = await generateDCPSReport(page, finalObject);
        } catch (err) {
          logger.error('DCPS PDF generation failed:', err.message);
          if (err.message === "Protocol error (Page.printToPDF): Printing failed") {
            const reAttemptTimeout = config.app.fsrReattemptTimeout;
            logger.info(`Re-attempting DCPS PDF generation after ${reAttemptTimeout}ms`);
            await sleep(reAttemptTimeout);
            bufferContent = await generateDCPSReport(page, finalObject);
          } else {
            throw err;
          }
        }
        break;

      default:
        throw new Error(`Invalid product group: ${param.product_group}`);
    }

    await browser.close();

    if (!bufferContent || !bufferContent.length) {
      throw new Error('PDF content is not generated or undefined');
    }

    logger.logPDFGeneration(param.product_group, param.call_no, 'SUCCESS');

    let etag = "";
    
    if (config.isS3Configured()) {
      try {
        await s3FSRFileOperations('post', `${param.call_no.toLowerCase()}.pdf`, bufferContent, '', `fsr/${new Date().getFullYear()}`);
        etag = await s3FSRFileOperations('location', `${param.call_no.toLowerCase()}.pdf`, '', '', `fsr/${new Date().getFullYear()}`);
        logger.logS3Operation('upload', `${param.call_no}.pdf`, 'SUCCESS', etag);
      } catch (s3Error) {
        logger.logS3Operation('upload', `${param.call_no}.pdf`, 'FAILED', s3Error.message);
      }
    } else {
      logger.warn('S3 not configured - PDF generated but not stored');
    }

    const response = {
      success: true,
      etag,
      fileName: `${param.call_no.toLowerCase()}.pdf`,
      path: `fsr/${new Date().getFullYear()}`
    };

    logger.logResponse('notification.report', response, userAgent);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify(response)
    };

  } catch (error) {
    logger.error('PDF generation failed:', error.message);
    
    const errorResponse = { 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
    
    logger.logResponse('notification.report', errorResponse, userAgent);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify(errorResponse)
    };
  }
};