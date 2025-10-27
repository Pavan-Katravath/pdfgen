const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');
const regularPuppeteer = require('puppeteer');
const templateLoader = require('../utils/templateLoader');
const logger = require('../utils/logger');
const config = require('../utils/config');
const { 
  generateOnePMFSR, 
  generateOnePMFSRChild,
  generateSafetyTableForOnepmFSR,
  generateProductsCoveredTable,
  generatePartReturnedAndConsumedTable,
  mergePDFs
} = require('../helpers/reportGenerationHelpers');
const { s3FSRFileOperations } = require('../helpers/s3Operations');
const { sleep, validateRequiredParams } = require('../utils/constants');

// Use regular puppeteer for local development
let puppeteerInstance = regularPuppeteer;
let useRegularPuppeteer = true;

module.exports.handler = async (event) => {
  const userAgent = event.headers?.['user-agent'] || '';
  logger.logRequestStart('report.onepmFSR', 'POST', event.body, userAgent);
  
  try {
    const param = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const paramObj = param.params ? JSON.parse(param.params) : undefined;
    
    // Validate required parameters
    validateRequiredParams(param, ['call_no', 'isOnepmFSR']);
    
    if (!param.isOnepmFSR) {
      throw new Error('isOnepmFSR must be true for this endpoint');
    }

    const onepmFSRStatus = {
      isChildPDFGenrated: false,
      isMergingDone: false,
      isMasterPDFGenerated: false,
      isEmailSent: false,
      isFileUploaded: false,
      isFileInGeneralRoom: false,
      etag: "",
      path: "",
      fileName: "",
    };

    let bufferArray = [];
    let etag = "";
    let checkListAttachments = [];

    // Extract signatures and other data
    const customerSignature = param?.signature && param.signature.length > 1
      ? param.signature
      : paramObj && paramObj?.signature 
        ? paramObj?.signature 
        : '';

    const engineerSignature = param?.engineerSignature && param?.engineerSignature.length > 1
      ? param?.engineerSignature
      : paramObj && paramObj?.engineerSignature 
        ? paramObj?.engineerSignature 
        : '';

    const request_owner = param?.request_owner ? param?.request_owner : paramObj?.request_owner ? paramObj?.request_owner : "";
    const booked_by = param?.booked_by ? param?.booked_by : paramObj?.booked_by ? paramObj?.booked_by : "";
    const engineerComment = param?.engineerComment ? param?.engineerComment : paramObj?.engineerComment ? paramObj?.engineerComment : "";
    const engineername = param?.engineername ? param?.engineername : paramObj?.engineername ? paramObj?.engineername : "";
    const fsr_number = param?.fsr_number ? param?.fsr_number : paramObj?.fsr_number ? paramObj?.fsr_number : "";
    const service_provider = param?.service_provider ? param?.service_provider : paramObj?.service_provider ? paramObj?.service_provider : "";

    logger.logPDFGeneration('onepmFSR', param.call_no, 'STARTED');

    // Configure Puppeteer for local vs Lambda environment
    let browserConfig;
    if (useRegularPuppeteer) {
      // Use regular puppeteer (includes Chrome)
      browserConfig = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ignoreHTTPSErrors: true,
      };
    } else {
      // Use puppeteer-core with chrome-aws-lambda
      browserConfig = {
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
      };
    }

    // Process child PDFs if they exist
    if (param.child && param.child.length) {
      // Create a lookup map for fast index retrieval
      const indexMap = new Map(param.summary.map((item, index) => [item.call_no, index]));
      // Sort bufferArray based on the order in param.summary
      param.child.sort((a, b) => (indexMap.get(a.call_no) || 0) - (indexMap.get(b.call_no) || 0));

      for (let i = 0; i < param.child.length; i++) {
        const childParam = param.child[i];
        const childParamObj = childParam.params ? JSON.parse(childParam.params) : undefined;

        // Checklist attachment for a child call
        checkListAttachments.push({
          [childParam.call_no]: {
            pm_checklist_url: childParam.pm_checklist_url ?? "",
            pm_document_url: childParam.pm_document_url ?? "",
            power_checklist_url: childParam.power_checklist_url ?? "",
            commissioning_checklist_url: childParam.commissioning_checklist_url ?? "",
            other_document_url: childParam.other_document_url ?? "",
            general_parameter_checklist_url: childParam.general_parameter_checklist_url ?? ""
          }
        });

        const { issuedEls, returnedEls } = generatePartReturnedAndConsumedTable(childParam, 3, true);

        const finalObject = {
          param: childParam,
          paramObj: childParamObj,
          tableHTML: generateSafetyTableForOnepmFSR(childParamObj?.formdata),
          returnedEls,
          issuedEls,
          engineerSignature,
          customerSignature,
          request_owner,
          booked_by,
          engineerComment,
          engineername,
          fsr_number,
          service_provider
        };

        const browser = await puppeteerInstance.launch(browserConfig);
        const page = await browser.newPage();
        let bufferContent = '';

        await page.setContent(templateLoader.getTemplate('onepmFSRChild'));
        try {
          bufferContent = await generateOnePMFSRChild(page, finalObject, i + 2, param.summary.length + 1);
          logger.logPDFGeneration('onepmFSRChild', childParam.call_no, 'SUCCESS');
          onepmFSRStatus.isChildPDFGenrated = true;
        } catch (err) {
          logger.error('OnePM FSR Child PDF generation failed:', err.message);
          if (err.message === "Protocol error (Page.printToPDF): Printing failed") {
            const reAttemptTimeout = config.app.fsrReattemptTimeout;
            logger.info(`Re-attempting OnePM FSR Child PDF generation after ${reAttemptTimeout}ms`);
            await sleep(reAttemptTimeout);
            bufferContent = await generateOnePMFSRChild(page, finalObject, i + 2, param.summary.length + 1);
            logger.logPDFGeneration('onepmFSRChild', childParam.call_no, 'SUCCESS');
            onepmFSRStatus.isChildPDFGenrated = true;
          } else {
            throw err;
          }
        }

        await browser.close();

        if (!bufferContent || !bufferContent.length) {
          throw new Error(`PDF content is not generated or undefined ${childParam.call_no}`);
        }

        bufferArray.push({ buffer: bufferContent, call_no: childParam.call_no });
      }
    }

    // Generate master PDF
    const finalObject = {
      param,
      paramObj,
      tableHTML: generateSafetyTableForOnepmFSR(paramObj?.formdata),
      productsCoveredHTML: generateProductsCoveredTable(param.summary, 8),
      engineerSignature,
      customerSignature,
      request_owner,
      booked_by,
      engineerComment,
      engineername,
      fsr_number
    };

    const browser = await puppeteerInstance.launch(browserConfig);
    const page = await browser.newPage();
    let bufferContent = '';

    await page.setContent(templateLoader.getTemplate('onepmFSR'));
    try {
      bufferContent = await generateOnePMFSR(page, finalObject, param.summary.length + 1);
      logger.logPDFGeneration('onepmFSRMaster', param.call_no, 'SUCCESS');
      onepmFSRStatus.isMasterPDFGenerated = true;
    } catch (err) {
      logger.error('OnePM FSR Master PDF generation failed:', err.message);
      if (err.message === "Protocol error (Page.printToPDF): Printing failed") {
        const reAttemptTimeout = config.app.fsrReattemptTimeout;
        logger.info(`Re-attempting OnePM FSR Master PDF generation after ${reAttemptTimeout}ms`);
        await sleep(reAttemptTimeout);
        bufferContent = await generateOnePMFSR(page, finalObject, param.summary.length + 1);
        logger.logPDFGeneration('onepmFSRMaster', param.call_no, 'SUCCESS');
        onepmFSRStatus.isMasterPDFGenerated = true;
      } else {
        throw err;
      }
    }

    await browser.close();

    if (!bufferContent || !bufferContent.length) {
      throw new Error('PDF content is not generated for Master Copy of onepmFSR.');
    }

    // Merge PDFs
    bufferArray.unshift({ buffer: bufferContent });
    const mergedBufferContent = await mergePDFs(bufferArray);
    logger.logPDFGeneration('onepmFSRMerged', param.call_no, 'SUCCESS');
    onepmFSRStatus.isMergingDone = true;

    // Upload to S3
    if (config.isS3Configured()) {
      try {
        await s3FSRFileOperations('post', `${param.call_no.toLowerCase()}.pdf`, mergedBufferContent, '', `fsr/${new Date().getFullYear()}`);
        etag = await s3FSRFileOperations('location', `${param.call_no.toLowerCase()}.pdf`, '', '', `fsr/${new Date().getFullYear()}`);
        logger.logS3Operation('upload', `${param.call_no}.pdf`, 'SUCCESS', etag);
        onepmFSRStatus.isFileUploaded = true;
        onepmFSRStatus.etag = etag;
        onepmFSRStatus.fileName = `${param.call_no.toLowerCase()}.pdf`;
        onepmFSRStatus.path = `fsr/${new Date().getFullYear()}`;
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
      path: `fsr/${new Date().getFullYear()}`,
      status: onepmFSRStatus
    };

    logger.logResponse('report.onepmFSR', response, userAgent);

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
    logger.error('OnePM FSR generation failed:', error.message);
    
    const errorResponse = { 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
    
    logger.logResponse('report.onepmFSR', errorResponse, userAgent);
    
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
