const AWS = require('aws-sdk');
const config = require('../utils/config');
const logger = require('../utils/logger');

const s3 = new AWS.S3(config.getS3Config());

async function s3FSRFileOperations(type, Key, Body = '', call_no = '', path = '', isChecklist = false) {
  try {
    const bucketName = config.s3.bucket;
    const fullPath = path ? `${path}/${Key}` : Key;
    
    const params = {
      Bucket: bucketName,
      Key: fullPath,
    };

    switch (type) {
      case 'post':
        params.Body = Body;
        params.ContentType = 'application/pdf';
        params.Metadata = {
          'call-no': call_no,
          'generated-at': new Date().toISOString(),
          'is-checklist': isChecklist.toString()
        };
        
        const uploadResult = await s3.upload(params).promise();
        logger.logS3Operation('upload', Key, 'SUCCESS', uploadResult.Location);
        return uploadResult.ETag;

      case 'read':
        const readResult = await s3.getObject(params).promise();
        logger.logS3Operation('read', Key, 'SUCCESS');
        return readResult.Body;

      case 'location':
        const locationData = await s3.getObject(params).promise();
        logger.logS3Operation('generate-url', Key, 'SUCCESS');
        return locationData.ETag;

      default:
        throw new Error(`Unsupported operation type: ${type}`);
    }

  } catch (error) {
    logger.logS3Operation(type, Key, 'FAILED', error.message);
    throw error;
  }
}

module.exports = { s3FSRFileOperations };
