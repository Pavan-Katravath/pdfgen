const fs = require('fs');
const path = require('path');

class TemplateLoader {
  constructor() {
    this.templates = {};
    this.templateDir = path.join(__dirname, '../templates');
    this.loadTemplates();
  }

      loadTemplates() {
        const templateFiles = [
          'dpg.html',
          'thermal.html',
          'dcps.html',
          'onepmFSR.html',
          'onepmFSRChild.html',
          'dpg_checklist.html',
          'thermal_checklist.html',
          'dcps_checklist.html'
        ];
    
    templateFiles.forEach(file => {
      const templateName = file.replace('.html', '');
      const templatePath = path.join(this.templateDir, file);
      
      try {
        if (fs.existsSync(templatePath)) {
          this.templates[templateName] = fs.readFileSync(templatePath, 'utf8');
        } else {
          console.warn(`Template file not found: ${templatePath}`);
        }
      } catch (error) {
        console.error(`Failed to load template ${templateName}:`, error.message);
      }
    });
  }

  getTemplate(templateName) {
    if (!this.templates[templateName]) {
      throw new Error(`Template ${templateName} not found. Available templates: ${Object.keys(this.templates).join(', ')}`);
    }
    console.log(`Loaded template: ${templateName}`);
    return this.templates[templateName];
  }

  getAllTemplates() {
    return this.templates;
  }

  getTemplateNames() {
    return Object.keys(this.templates);
  }

  validateTemplate(templateName) {
    const template = this.getTemplate(templateName);
    
    // Basic validation - check for common required elements
    const requiredElements = this.getRequiredElements(templateName);
    const missingElements = requiredElements.filter(element => 
      !template.includes(`id="${element}"`)
    );
    
    if (missingElements.length > 0) {
      console.warn(`Template ${templateName} missing elements:`, missingElements);
    }
    
    return missingElements.length === 0;
  }

  getRequiredElements(templateName) {
    const commonElements = ['customerName', 'fsrNumber', 'fsrDateAndTime'];
    
    switch (templateName) {
      case 'thermal':
        return [...commonElements, 'serviceType', 'observation', 'workDone', 'recommendation'];
      case 'dpg':
        return [...commonElements, 'productModel', 'serialNumber'];
      case 'dcps':
        return [...commonElements, 'siteId', 'productModel'];
      case 'onepmFSR':
        return [...commonElements, 'serviceType', 'assessment', 'productsCovered'];
      case 'onepmFSRChild':
        return [...commonElements, 'serviceType', 'productModel', 'observation', 'workDone', 'recommendation'];
      default:
        return commonElements;
    }
  }

  validateAllTemplates() {
    const results = {};
    const templates = this.getTemplateNames();
    
    templates.forEach(template => {
      results[template] = this.validateTemplate(template);
    });
    
    return results;
  }
}

module.exports = new TemplateLoader();
