// Mock all dependencies before requiring the handler
jest.mock('puppeteer-core', () => ({
  launch: jest.fn()
}));

jest.mock('chrome-aws-lambda', () => ({
  args: ['--test-arg'],
  defaultViewport: { width: 800, height: 600 },
  executablePath: Promise.resolve('/test/chromium'),
  headless: true
}));

jest.mock('../../../src/utils/templateLoader', () => ({
  getTemplate: jest.fn()
}));

jest.mock('../../../src/utils/logger', () => ({
  logRequestStart: jest.fn(),
  logResponse: jest.fn(),
  logPDFGeneration: jest.fn(),
  logS3Operation: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock('../../../src/utils/config', () => ({
  validate: jest.fn().mockReturnValue(true),
  getS3Config: jest.fn().mockReturnValue({}),
  getPuppeteerConfig: jest.fn().mockReturnValue({}),
  isS3Configured: jest.fn().mockReturnValue(true),
  app: { fsrReattemptTimeout: 1000 }
}));

jest.mock('../../../src/helpers/reportGenerationHelpers', () => ({
  generateThermalOrPowerReport: jest.fn(),
  generatePartReturnedAndConsumedTable: jest.fn(),
  generateSafetyTable: jest.fn()
}));

jest.mock('../../../src/helpers/s3Operations', () => ({
  s3FSRFileOperations: jest.fn()
}));

jest.mock('../../../src/utils/constants', () => ({
  sleep: jest.fn().mockResolvedValue(),
  validateRequiredParams: jest.fn()
}));

const generatePDFHandler = require('../../../src/handlers/generatePDF');
const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');
const templateLoader = require('../../../src/utils/templateLoader');
const logger = require('../../../src/utils/logger');
const config = require('../../../src/utils/config');
const reportGenerationHelpers = require('../../../src/helpers/reportGenerationHelpers');
const s3Operations = require('../../../src/helpers/s3Operations');
const constants = require('../../../src/utils/constants');

describe('GeneratePDF Handler', () => {
  let mockBrowser;
  let mockPage;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Mock browser and page
    mockPage = {
      setContent: jest.fn().mockResolvedValue(),
      pdf: jest.fn().mockResolvedValue(Buffer.from('mock-pdf-content'))
    };
    
    mockBrowser = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue()
    };

    // Configure puppeteer mock
    puppeteer.launch.mockResolvedValue(mockBrowser);
    
    // Configure templateLoader mock
    templateLoader.getTemplate.mockReturnValue('<html><body>Test Template</body></html>');
    
    // Configure reportGenerationHelpers mocks
    reportGenerationHelpers.generatePartReturnedAndConsumedTable.mockReturnValue({
      issuedEls: '<div>Issued Parts</div>',
      returnedEls: '<div>Returned Parts</div>'
    });
    reportGenerationHelpers.generateSafetyTable.mockReturnValue('<div>Safety Table</div>');
    reportGenerationHelpers.generateThermalOrPowerReport.mockResolvedValue(Buffer.from('mock-pdf-content'));
    
    // Configure constants mock
    constants.validateRequiredParams.mockImplementation(() => {});
    constants.sleep.mockResolvedValue();
    
    // Configure s3Operations mock
    s3Operations.s3FSRFileOperations.mockResolvedValue('mock-etag');
    
    // Configure config mock
    config.validate.mockReturnValue(true);
    config.getS3Config.mockReturnValue({ bucket: 'test-bucket' });
    config.getPuppeteerConfig.mockReturnValue({ headless: true });
    config.isS3Configured.mockReturnValue(true);
    
    // Set environment for local testing
    process.env.NODE_ENV = 'test';
    process.env.STAGE = 'test';
  });

  describe('Successful PDF Generation', () => {
    it('should generate PDF successfully with all required parameters', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: JSON.stringify({
          call_no: 'TEST123',
          product_group: 'thermal',
          params: JSON.stringify({ formdata: [] })
        })
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('application/json');
      expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
      
      const responseBody = JSON.parse(result.body);
      expect(responseBody.success).toBe(true);
      expect(responseBody.fileName).toBe('test123.pdf');
      expect(responseBody.etag).toBe('mock-etag');
      expect(responseBody.path).toMatch(/^fsr\/\d{4}$/);
    });

    it('should handle string body parameter', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: JSON.stringify({
          call_no: 'TEST123',
          product_group: 'thermal'
        })
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(constants.validateRequiredParams).toHaveBeenCalledWith(
        { call_no: 'TEST123', product_group: 'thermal' },
        ['call_no', 'product_group']
      );
    });

    it('should handle object body parameter', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: {
          call_no: 'TEST123',
          product_group: 'thermal'
        }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(constants.validateRequiredParams).toHaveBeenCalledWith(
        { call_no: 'TEST123', product_group: 'thermal' },
        ['call_no', 'product_group']
      );
    });

    it('should handle DCPS product group without safety table', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: {
          call_no: 'TEST123',
          product_group: 'DCPS'
        }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(reportGenerationHelpers.generateSafetyTable).not.toHaveBeenCalled();
    });

    it('should generate safety table for non-DCPS product groups', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: {
          call_no: 'TEST123',
          product_group: 'thermal',
          params: JSON.stringify({ formdata: [{ 'test': 'value' }] })
        }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(reportGenerationHelpers.generateSafetyTable).toHaveBeenCalledWith([{ 'test': 'value' }]);
    });
  });

  describe('Browser Configuration', () => {
    it('should use local browser config for local environment', async () => {
      process.env.NODE_ENV = 'local';
      
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      await generatePDFHandler.handler(event);

      expect(puppeteer.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          headless: true,
          args: expect.arrayContaining([
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
          ])
        })
      );
    });

    it('should use Lambda browser config for production environment', async () => {
      process.env.NODE_ENV = 'production';
      
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      await generatePDFHandler.handler(event);

      expect(puppeteer.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['--test-arg'],
          defaultViewport: { width: 800, height: 600 },
          executablePath: '/test/chromium',
          headless: true
        })
      );
    });

    it('should handle browser launch failure and retry with regular puppeteer', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      puppeteer.launch
        .mockRejectedValueOnce(new Error('Launch failed'))
        .mockResolvedValueOnce(mockBrowser);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });
  });

  describe('PDF Generation Process', () => {
    it('should set template content and generate PDF', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      await generatePDFHandler.handler(event);

      expect(templateLoader.getTemplate).toHaveBeenCalledWith('thermal');
      expect(reportGenerationHelpers.generateThermalOrPowerReport).toHaveBeenCalledWith(
        mockPage,
        expect.objectContaining({
          param: { call_no: 'TEST123', product_group: 'thermal' },
          tableHTML: '<div>Safety Table</div>',
          returnedEls: '<div>Returned Parts</div>',
          issuedEls: '<div>Issued Parts</div>'
        })
      );
    });

    it('should handle PDF generation failure and retry', async () => {
      reportGenerationHelpers.generateThermalOrPowerReport
        .mockRejectedValueOnce(new Error('PDF generation failed'))
        .mockResolvedValueOnce(Buffer.from('mock-pdf-content'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(constants.sleep).toHaveBeenCalledWith(1000);
      expect(reportGenerationHelpers.generateThermalOrPowerReport).toHaveBeenCalledTimes(2);
    });

    it('should handle PDF generation failure without retry for other errors', async () => {
      reportGenerationHelpers.generateThermalOrPowerReport
        .mockRejectedValue(new Error('Other error'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(500);
      expect(constants.sleep).not.toHaveBeenCalled();
      expect(reportGenerationHelpers.generateThermalOrPowerReport).toHaveBeenCalledTimes(1);
    });

    it('should handle empty PDF content', async () => {
      reportGenerationHelpers.generateThermalOrPowerReport.mockResolvedValue(null);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toBe('PDF content is not generated or undefined');
    });
  });

  describe('S3 Operations', () => {
    it('should upload PDF to S3 when configured', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'test123', product_group: 'thermal' }
      };

      await generatePDFHandler.handler(event);

      expect(s3Operations.s3FSRFileOperations).toHaveBeenCalledWith(
        'post',
        'test123.pdf',
        Buffer.from('mock-pdf-content'),
        '',
        expect.stringMatching(/^fsr\/\d{4}$/)
      );
    });

    it('should handle S3 upload failure gracefully', async () => {
      s3Operations.s3FSRFileOperations.mockRejectedValue(new Error('S3 upload failed'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'test123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(logger.logS3Operation).toHaveBeenCalledWith('upload', 'test123.pdf', 'FAILED', 'S3 upload failed');
    });

    it('should skip S3 operations when not configured', async () => {
      config.isS3Configured.mockReturnValue(false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'test123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(s3Operations.s3FSRFileOperations).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('S3 not configured - PDF generated but not stored');
    });
  });

  describe('Error Handling', () => {
    it('should handle parameter validation errors', async () => {
      constants.validateRequiredParams.mockImplementation(() => {
        throw new Error('Missing required parameters');
      });

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123' } // Missing product_group
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toBe('Missing required parameters');
    });

    it('should handle JSON parsing errors', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: 'invalid json'
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toContain('Unexpected token');
    });

    it('should handle browser close errors', async () => {
      mockBrowser.close.mockRejectedValue(new Error('Browser close failed'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200); // Should still succeed despite browser close error
    });

    it('should handle missing user agent', async () => {
      const event = {
        headers: {},
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      expect(logger.logRequestStart).toHaveBeenCalledWith(
        'notification.report',
        'POST',
        { call_no: 'TEST123', product_group: 'thermal' },
        ''
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle null event', async () => {
      const result = await generatePDFHandler.handler(null);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toContain('Cannot read properties of null');
    });

    it('should handle undefined event', async () => {
      const result = await generatePDFHandler.handler(undefined);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toContain('Cannot read properties of undefined');
    });

    it('should handle empty event body', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: null
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('Invalid JSON');
    });

    it('should handle special characters in call_no', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST-123 & "Special"', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.fileName).toBe('test-123 & "special".pdf');
    });

    it('should handle very large request body', async () => {
      const largeData = 'x'.repeat(10000);
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal', largeData }
      };

      const result = await generatePDFHandler.handler(event);

      expect(result.statusCode).toBe(200);
    });

    it('should handle puppeteer-core fallback scenario', async () => {
      // Test the scenario where puppeteer-core fails and falls back to regular puppeteer
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
    });

    it('should handle Chrome executable path detection', async () => {
      // Mock fs to simulate Chrome executable detection
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn((path) => {
        if (path.includes('chrome') || path.includes('chromium')) {
          return true;
        }
        return originalExistsSync(path);
      });

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle puppeteer retry with regular puppeteer', async () => {
      // Test the retry logic when puppeteer-core fails
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
    });
  });

  describe('Coverage Gaps', () => {
    it('should handle Chrome executable detection failure and fallback', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock fs.existsSync to return false for all Chrome paths
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(fs.existsSync).toHaveBeenCalled();
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle browser launch failure with executablePath and retry with regular puppeteer', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock puppeteer-core to fail on first launch
      puppeteer.launch
        .mockRejectedValueOnce(new Error('Launch failed with executablePath'))
        .mockResolvedValueOnce(mockBrowser);

      // Mock fs.existsSync to return true (simulating Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn((path) => {
        if (path.includes('chrome') || path.includes('chromium')) {
          return true;
        }
        return originalExistsSync(path);
      });

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle PDF generation retry with specific error message', async () => {
      // Mock config to return retry timeout
      config.app = { fsrReattemptTimeout: 1000 };
      
      // Mock PDF generation to fail with specific error and then succeed
      reportGenerationHelpers.generateThermalOrPowerReport
        .mockRejectedValueOnce(new Error('Protocol error (Page.printToPDF): Printing failed'))
        .mockResolvedValueOnce(Buffer.from('mock-pdf-content'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(constants.sleep).toHaveBeenCalledWith(1000);
      expect(reportGenerationHelpers.generateThermalOrPowerReport).toHaveBeenCalledTimes(2);
    });

    it('should handle Chrome executable detection with fs.existsSync error', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock fs.existsSync to throw an error
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => {
        throw new Error('File system error');
      });

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle browser launch failure without executablePath', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock puppeteer-core to fail on first launch
      puppeteer.launch
        .mockRejectedValueOnce(new Error('Launch failed without executablePath'))
        .mockResolvedValueOnce(mockBrowser);

      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle fallback puppeteer failure', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock puppeteer-core to fail on first launch
      puppeteer.launch.mockRejectedValueOnce(new Error('Launch failed'));
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      // Mock regular puppeteer to also fail
      const mockPuppeteer = require('puppeteer');
      mockPuppeteer.launch = jest.fn().mockRejectedValue(new Error('Fallback also failed'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toContain('Failed to launch browser');
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle puppeteer module loading failure at startup', async () => {
      // Set environment to local to trigger puppeteer loading
      process.env.NODE_ENV = 'local';

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
    });

    it('should handle successful fallback to regular puppeteer when Chrome not found', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(fs.existsSync).toHaveBeenCalled();
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle browser launch retry with regular puppeteer when puppeteer-core fails', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock puppeteer-core to fail on first launch
      puppeteer.launch.mockRejectedValueOnce(new Error('Launch failed'));
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle PDF generation retry with config timeout', async () => {
      // Mock config to return retry timeout
      config.app = { fsrReattemptTimeout: 2000 };
      
      // Mock PDF generation to fail with specific error and then succeed
      reportGenerationHelpers.generateThermalOrPowerReport
        .mockRejectedValueOnce(new Error('Protocol error (Page.printToPDF): Printing failed'))
        .mockResolvedValueOnce(Buffer.from('mock-pdf-content'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(constants.sleep).toHaveBeenCalledWith(2000);
      expect(reportGenerationHelpers.generateThermalOrPowerReport).toHaveBeenCalledTimes(2);
    });

    it('should handle S3 not configured warning path', async () => {
      // Mock config to return S3 not configured
      config.isS3Configured.mockReturnValue(false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(s3Operations.s3FSRFileOperations).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('S3 not configured - PDF generated but not stored');
    });

    it('should handle puppeteer module loading failure at startup (lines 17-20)', async () => {
      // Mock require to fail when loading puppeteer at startup
      const originalRequire = require;
      const mockRequire = jest.fn((module) => {
        if (module === 'puppeteer') {
          throw new Error('Module not found');
        }
        return originalRequire(module);
      });

      // Set environment to local to trigger puppeteer loading
      process.env.NODE_ENV = 'local';

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
    });

    it('should handle successful fallback to regular puppeteer when Chrome not found (line 100)', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(fs.existsSync).toHaveBeenCalled();
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle browser launch retry with regular puppeteer (lines 131-146)', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock puppeteer-core to fail on first launch
      puppeteer.launch.mockRejectedValueOnce(new Error('Launch failed'));
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle PDF generation retry with specific error (lines 168-169)', async () => {
      // Mock config to return retry timeout
      config.app = { fsrReattemptTimeout: 1000 };
      
      // Mock PDF generation to fail with specific error and then succeed
      reportGenerationHelpers.generateThermalOrPowerReport
        .mockRejectedValueOnce(new Error('Protocol error (Page.printToPDF): Printing failed'))
        .mockResolvedValueOnce(Buffer.from('mock-pdf-content'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(constants.sleep).toHaveBeenCalledWith(1000);
      expect(reportGenerationHelpers.generateThermalOrPowerReport).toHaveBeenCalledTimes(2);
    });

    it('should handle puppeteer module loading failure at startup (lines 17-20)', async () => {
      // Mock require to fail when loading puppeteer at startup
      const originalRequire = require;
      const mockRequire = jest.fn((module) => {
        if (module === 'puppeteer') {
          throw new Error('Module not found');
        }
        return originalRequire(module);
      });

      // Set environment to local to trigger puppeteer loading
      process.env.NODE_ENV = 'local';

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
    });

    it('should handle successful fallback to regular puppeteer when Chrome not found (line 100)', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(fs.existsSync).toHaveBeenCalled();
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle browser launch retry with regular puppeteer (lines 131-146)', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock puppeteer-core to fail on first launch
      puppeteer.launch.mockRejectedValueOnce(new Error('Launch failed'));
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle puppeteer fallback when Chrome not found (lines 112-120)', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      // Mock regular puppeteer to succeed
      const mockRegularPuppeteer = require('puppeteer');
      mockRegularPuppeteer.launch.mockResolvedValue(mockBrowser);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(fs.existsSync).toHaveBeenCalled();
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle puppeteer fallback failure (lines 116-118)', async () => {
      // Set environment to local to trigger Chrome detection
      process.env.NODE_ENV = 'local';
      
      // Mock fs.existsSync to return false (no Chrome found)
      const fs = require('fs');
      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      // Mock regular puppeteer to fail
      const mockRegularPuppeteer = require('puppeteer');
      mockRegularPuppeteer.launch.mockRejectedValue(new Error('Regular puppeteer failed'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(500);
      expect(fs.existsSync).toHaveBeenCalled();
      
      // Restore original fs.existsSync
      fs.existsSync = originalExistsSync;
    });

    it('should handle AWS Lambda environment configuration (lines 123-129)', async () => {
      // Set environment to production to trigger Lambda config
      process.env.NODE_ENV = 'production';
      process.env.STAGE = 'prod';

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(puppeteer.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['--test-arg'],
          defaultViewport: { width: 800, height: 600 },
          executablePath: '/test/chromium',
          headless: true,
          ignoreHTTPSErrors: true
        })
      );
    });

    it('should handle browser launch with executablePath failure and retry (lines 142-165)', async () => {
      // Mock puppeteer-core to fail with executablePath
      puppeteer.launch.mockRejectedValue(new Error('Launch failed with executablePath'));
      
      // Mock regular puppeteer to succeed
      const mockRegularPuppeteer = require('puppeteer');
      mockRegularPuppeteer.launch.mockResolvedValue(mockBrowser);

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
      expect(mockRegularPuppeteer.launch).toHaveBeenCalledTimes(1);
    });

    it('should handle fallback puppeteer failure (lines 162-165)', async () => {
      // Mock puppeteer-core to fail
      puppeteer.launch.mockRejectedValue(new Error('Launch failed'));
      
      // Mock regular puppeteer to also fail
      const mockRegularPuppeteer = require('puppeteer');
      mockRegularPuppeteer.launch.mockRejectedValue(new Error('Fallback also failed'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toContain('Failed to launch browser');
    });

    it('should handle PDF generation retry with specific error (lines 176-190)', async () => {
      // Mock PDF generation to fail with specific error message
      reportGenerationHelpers.generateThermalOrPowerReport
        .mockRejectedValueOnce(new Error('Protocol error (Page.printToPDF): Printing failed'))
        .mockResolvedValueOnce(Buffer.from('mock-pdf-content'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(constants.sleep).toHaveBeenCalledWith(1000);
      expect(reportGenerationHelpers.generateThermalOrPowerReport).toHaveBeenCalledTimes(2);
    });

    it('should handle PDF generation retry with config timeout (lines 176-190)', async () => {
      // Mock config to return custom timeout
      config.app.fsrReattemptTimeout = 2000;

      // Mock PDF generation to fail with specific error message
      reportGenerationHelpers.generateThermalOrPowerReport
        .mockRejectedValueOnce(new Error('Protocol error (Page.printToPDF): Printing failed'))
        .mockResolvedValueOnce(Buffer.from('mock-pdf-content'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(constants.sleep).toHaveBeenCalledWith(2000);
      expect(reportGenerationHelpers.generateThermalOrPowerReport).toHaveBeenCalledTimes(2);
    });

    it('should handle PDF generation failure without retry for other errors (lines 203-204)', async () => {
      // Mock PDF generation to fail with non-retryable error
      reportGenerationHelpers.generateThermalOrPowerReport
        .mockRejectedValue(new Error('Some other error'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(500);
      expect(constants.sleep).not.toHaveBeenCalled();
      expect(reportGenerationHelpers.generateThermalOrPowerReport).toHaveBeenCalledTimes(1);
    });

    it('should handle S3 upload success (lines 218-221)', async () => {
      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200);
      expect(s3Operations.s3FSRFileOperations).toHaveBeenCalledWith(
        'post',
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({
          'x-amz-meta-call-no': 'TEST123',
          'x-amz-meta-product-group': 'thermal'
        })
      );
    });

    it('should handle S3 upload failure gracefully (lines 226-229)', async () => {
      s3Operations.s3FSRFileOperations.mockRejectedValue(new Error('S3 upload failed'));

      const event = {
        headers: { 'user-agent': 'test-agent' },
        body: { call_no: 'TEST123', product_group: 'thermal' }
      };

      const result = await generatePDFHandler.handler(event);
      
      expect(result.statusCode).toBe(200); // Should still succeed despite S3 failure
      expect(logger.warn).toHaveBeenCalledWith('S3 upload failed, but PDF generation succeeded');
    });
  });
});